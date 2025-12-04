const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const QUIZ_ROOM_PREFIX = 'quiz-';

const quizzes = new Map();

function normalise(text = '') {
  return text.trim().toLowerCase();
}

function formatLeaderboard(quiz) {
  return Array.from(quiz.players.values())
    .sort((a, b) => b.score - a.score)
    .map(({ name, score }) => ({ name, score }));
}

function emitLeaderboard(quizId) {
  const quiz = quizzes.get(quizId);
  if (!quiz) return;
  const leaderboard = formatLeaderboard(quiz);
  io.to(`${QUIZ_ROOM_PREFIX}${quizId}`).emit('leaderboard:update', leaderboard);
}

function clearQuestionState(quiz) {
  quiz.questionActive = false;
  quiz.questionStart = null;
  quiz.answers = new Set();
}

io.on('connection', (socket) => {
  socket.on('host:createQuiz', ({ title, questions, questionDuration }) => {
    if (!Array.isArray(questions) || questions.length === 0) {
      socket.emit('host:error', 'Please add at least one question.');
      return;
    }
    const sanitizedQuestions = questions
      .filter((q) => q && q.prompt && q.answer)
      .map((q) => ({ prompt: q.prompt.trim(), answer: q.answer.trim() }));
    if (!sanitizedQuestions.length) {
      socket.emit('host:error', 'Questions need both prompts and answers.');
      return;
    }

    const quizId = nanoid(6).toUpperCase();
    quizzes.set(quizId, {
      id: quizId,
      title: title?.trim() || 'Classroom Quiz',
      hostId: socket.id,
      players: new Map(),
      questions: sanitizedQuestions,
      questionDuration: Number(questionDuration) || 20,
      currentQuestionIndex: -1,
      questionStart: null,
      answers: new Set(),
      questionActive: false,
    });

    socket.join(`${QUIZ_ROOM_PREFIX}${quizId}`);
    socket.emit('host:quizCreated', { quizId });
  });

  socket.on('player:join', ({ quizId, name }) => {
    const quiz = quizzes.get(quizId?.trim()?.toUpperCase());
    if (!quiz) {
      socket.emit('player:error', 'Quiz not found. Double check the code.');
      return;
    }

    const displayName = name?.trim();
    if (!displayName) {
      socket.emit('player:error', 'Please enter your name.');
      return;
    }

    quiz.players.set(socket.id, {
      id: socket.id,
      name: displayName,
      score: 0,
    });

    socket.join(`${QUIZ_ROOM_PREFIX}${quiz.id}`);
    socket.emit('player:joined', {
      quizId: quiz.id,
      title: quiz.title,
      totalQuestions: quiz.questions.length,
      questionDuration: quiz.questionDuration,
    });
    io.to(quiz.hostId).emit('host:playerJoined', formatLeaderboard(quiz));
    emitLeaderboard(quiz.id);
  });

  socket.on('host:startQuestion', ({ quizId }) => {
    const quiz = quizzes.get(quizId?.trim()?.toUpperCase());
    if (!quiz || quiz.hostId !== socket.id) return;

    const nextIndex = quiz.currentQuestionIndex + 1;
    if (nextIndex >= quiz.questions.length) {
      io.to(`${QUIZ_ROOM_PREFIX}${quizId}`).emit('quiz:finished');
      return;
    }

    quiz.currentQuestionIndex = nextIndex;
    quiz.questionStart = Date.now();
    quiz.questionActive = true;
    quiz.answers = new Set();

    const currentQuestion = quiz.questions[nextIndex];
    io.to(`${QUIZ_ROOM_PREFIX}${quizId}`).emit('question:start', {
      prompt: currentQuestion.prompt,
      index: nextIndex + 1,
      total: quiz.questions.length,
      duration: quiz.questionDuration,
    });
  });

  socket.on('player:answer', ({ quizId, answer }) => {
    const quiz = quizzes.get(quizId?.trim()?.toUpperCase());
    if (!quiz || !quiz.questionActive) return;
    const player = quiz.players.get(socket.id);
    if (!player || quiz.answers.has(socket.id)) return;

    const submitted = answer ?? '';
    const currentQuestion = quiz.questions[quiz.currentQuestionIndex];
    const elapsedMs = Date.now() - quiz.questionStart;
    const durationMs = quiz.questionDuration * 1000;
    const timeRemaining = Math.max(0, durationMs - elapsedMs);

    const isCorrect = normalise(submitted) === normalise(currentQuestion.answer);
    let earned = 0;
    if (isCorrect) {
      const speedBonus = Math.round((timeRemaining / durationMs) * 500);
      earned = 1000 + speedBonus;
      player.score += earned;
    }

    quiz.answers.add(socket.id);
    socket.emit('player:answerResult', {
      correct: isCorrect,
      earned,
      correctAnswer: currentQuestion.answer,
    });

    emitLeaderboard(quiz.id);
  });

  socket.on('host:endQuestion', ({ quizId }) => {
    const quiz = quizzes.get(quizId?.trim()?.toUpperCase());
    if (!quiz || quiz.hostId !== socket.id) return;
    const currentQuestion = quiz.questions[quiz.currentQuestionIndex];
    clearQuestionState(quiz);
    io.to(`${QUIZ_ROOM_PREFIX}${quizId}`).emit('question:end', {
      correctAnswer: currentQuestion?.answer,
    });
  });

  socket.on('disconnect', () => {
    for (const [quizId, quiz] of quizzes) {
      if (quiz.hostId === socket.id) {
        io.to(`${QUIZ_ROOM_PREFIX}${quizId}`).emit('quiz:ended');
        quizzes.delete(quizId);
        continue;
      }
      if (quiz.players.has(socket.id)) {
        quiz.players.delete(socket.id);
        emitLeaderboard(quizId);
      }
    }
  });
});

app.use(express.static('public'));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

server.listen(PORT, () => {
  /* eslint-disable no-console */
  console.log(`Quiz server listening on http://localhost:${PORT}`);
});

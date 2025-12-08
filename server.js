import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'quizzes.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const QUIZ_ROOM_PREFIX = 'quiz-';
const PLAYER_RECONNECT_GRACE_MS = 15000;

const quizTemplates = new Map();
const sessions = new Map();
const socketToPlayer = new Map();

function serializeForStorage() {
  return Array.from(quizTemplates.values()).map((quiz) => ({
    id: quiz.id,
    title: quiz.title,
    questions: quiz.questions,
    questionDuration: quiz.questionDuration,
    createdAt: quiz.createdAt,
  }));
}

async function persistQuizzes() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(serializeForStorage());
  await fs.writeFile(DATA_FILE, payload, 'utf8');
}

async function loadPersistedQuizzes() {
  try {
    const file = await fs.readFile(DATA_FILE, 'utf8');
    const stored = JSON.parse(file);
    stored.forEach((quiz) => {
      quizTemplates.set(quiz.id, quiz);
    });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      /* eslint-disable no-console */
      console.error('Failed to load quizzes from disk', error);
    }
  }
}

function buildMediaPayload(media) {
  if (!media || !media.src || !media.type) return null;
  return {
    type: media.type,
    src: media.src,
    name: media.name || '',
  };
}

function normalise(text = '') {
  return text.trim().toLowerCase();
}

function formatLeaderboard(session) {
  return Array.from(session.players.values())
    .sort((a, b) => b.score - a.score)
    .map(({ name, score }) => ({ name, score }));
}

function bindPlayerToSocket(session, player, socket) {
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }
  player.socketId = socket.id;
  player.disconnectedAt = null;
  socketToPlayer.set(socket.id, { sessionId: session.id, playerId: player.id });
  socket.join(`${QUIZ_ROOM_PREFIX}${session.id}`);
}

function schedulePlayerRemoval(sessionId, playerId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const player = session.players.get(playerId);
  if (!player) return;

  player.disconnectTimer = setTimeout(() => {
    session.players.delete(playerId);
    session.answers.delete(playerId);
    emitLeaderboard(sessionId);
  }, PLAYER_RECONNECT_GRACE_MS);
}

function countConnectedPlayers(session) {
  return Array.from(session.players.values()).filter((player) => !player.disconnectedAt).length;
}

function buildPlayerState(session, playerId) {
  const lobbyCountdownSeconds = session.lobbyExpiresAt
    ? Math.max(0, Math.ceil((session.lobbyExpiresAt - Date.now()) / 1000))
    : null;

  let question = null;
  if (session.questionActive && session.currentQuestionIndex >= 0) {
    const currentQuestion = session.questions[session.currentQuestionIndex];
    const elapsedSeconds = Math.floor((Date.now() - session.questionStart) / 1000);
    const timeRemaining = Math.max(0, session.questionDuration - elapsedSeconds);
    question = {
      prompt: currentQuestion.prompt,
      index: session.currentQuestionIndex + 1,
      total: session.questions.length,
      duration: session.questionDuration,
      media: currentQuestion.media,
      timeRemaining,
      hasAnswered: session.answers.has(playerId),
    };
  }

  let overlay = null;
  if (session.leaderboardEndsAt) {
    overlay = {
      leaderboard: formatLeaderboard(session),
      duration: Math.max(0, Math.ceil((session.leaderboardEndsAt - Date.now()) / 1000)),
    };
  } else if (session.finished) {
    overlay = {
      leaderboard: formatLeaderboard(session),
      duration: null,
    };
  }

  return {
    quizId: session.id,
    title: session.title,
    totalQuestions: session.questions.length,
    questionDuration: session.questionDuration,
    playerId,
    question,
    leaderboard: formatLeaderboard(session),
    currentQuestionIndex: session.currentQuestionIndex,
    lobbyCountdownSeconds,
    overlay,
    quizFinished: session.finished,
  };
}

function emitLeaderboard(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const leaderboard = formatLeaderboard(session);
  io.to(`${QUIZ_ROOM_PREFIX}${sessionId}`).emit('leaderboard:update', leaderboard);
}

function clearQuestionState(session) {
  session.questionActive = false;
  session.questionStart = null;
  session.answers = new Set();
  if (session.questionTimer) {
    clearTimeout(session.questionTimer);
    session.questionTimer = null;
  }
  if (session.leaderboardTimer) {
    clearTimeout(session.leaderboardTimer);
    session.leaderboardTimer = null;
  }
  session.leaderboardEndsAt = null;
}

function createSessionFromTemplate(template, hostId = null) {
  const sessionId = nanoid(6).toUpperCase();
  const session = {
    id: sessionId,
    templateId: template.id,
    hostId,
    title: template.title,
    players: new Map(),
    questions: template.questions,
    questionDuration: template.questionDuration,
    currentQuestionIndex: -1,
    questionStart: null,
    answers: new Set(),
    questionActive: false,
    createdAt: Date.now(),
    questionTimer: null,
    leaderboardTimer: null,
    lobbyTimer: null,
    lobbyExpiresAt: null,
    leaderboardEndsAt: null,
    finished: false,
  };
  sessions.set(sessionId, session);
  return session;
}

function scheduleLeaderboard(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const leaderboard = formatLeaderboard(session);
  const hasMoreQuestions = session.currentQuestionIndex + 1 < session.questions.length;
  io.to(`${QUIZ_ROOM_PREFIX}${sessionId}`).emit('leaderboard:show', {
    leaderboard,
    duration: hasMoreQuestions ? 2 : null,
  });

  session.leaderboardEndsAt = Date.now() + 2000;

  if (hasMoreQuestions) {
    session.leaderboardTimer = setTimeout(() => {
      session.leaderboardEndsAt = null;
      session.leaderboardTimer = null;
      startQuestion(sessionId);
    }, 2000);
  } else {
    session.leaderboardTimer = setTimeout(() => {
      session.leaderboardEndsAt = null;
      session.finished = true;
      session.leaderboardTimer = null;
      io.to(`${QUIZ_ROOM_PREFIX}${sessionId}`).emit('quiz:finished');
    }, 2000);
  }
}

function startQuestion(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.leaderboardTimer) {
    clearTimeout(session.leaderboardTimer);
    session.leaderboardTimer = null;
  }

  if (session.questionActive) return;

  const nextIndex = session.currentQuestionIndex + 1;
  if (nextIndex >= session.questions.length) {
    io.to(`${QUIZ_ROOM_PREFIX}${sessionId}`).emit('quiz:finished');
    return;
  }

  session.currentQuestionIndex = nextIndex;
  session.questionStart = Date.now();
  session.questionActive = true;
  session.finished = false;
  session.answers = new Set();
  session.leaderboardEndsAt = null;
  if (session.lobbyTimer) {
    clearTimeout(session.lobbyTimer);
    session.lobbyTimer = null;
    session.lobbyExpiresAt = null;
  }

  const currentQuestion = session.questions[nextIndex];
  io.to(`${QUIZ_ROOM_PREFIX}${sessionId}`).emit('question:start', {
    prompt: currentQuestion.prompt,
    index: nextIndex + 1,
    total: session.questions.length,
    duration: session.questionDuration,
    media: currentQuestion.media,
  });

  session.questionTimer = setTimeout(() => endQuestion(sessionId), session.questionDuration * 1000);
}

function endQuestion(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !session.questionActive) return;
  const currentQuestion = session.questions[session.currentQuestionIndex];
  clearQuestionState(session);
  io.to(`${QUIZ_ROOM_PREFIX}${sessionId}`).emit('question:end', {
    correctAnswer: currentQuestion?.answer,
  });
  scheduleLeaderboard(sessionId);
}

await loadPersistedQuizzes();

io.on('connection', (socket) => {
  socket.on('host:createQuiz', ({ title, questions, questionDuration }) => {
    if (!Array.isArray(questions) || questions.length === 0) {
      socket.emit('host:error', 'Please add at least one question.');
      return;
    }
    const sanitizedQuestions = questions
      .filter((q) => q && q.prompt && q.answer)
      .map((q) => ({
        prompt: q.prompt.trim(),
        answer: q.answer.trim(),
        alternateAnswers: Array.isArray(q.alternateAnswers)
          ? q.alternateAnswers.map((alt) => alt.trim()).filter(Boolean)
          : [],
        media: buildMediaPayload(q.media),
      }));
    if (!sanitizedQuestions.length) {
      socket.emit('host:error', 'Questions need both prompts and answers.');
      return;
    }

    const templateId = nanoid(6).toUpperCase();
    const template = {
      id: templateId,
      title: title?.trim() || 'Classroom Quiz',
      questions: sanitizedQuestions,
      questionDuration: Number(questionDuration) || 20,
      createdAt: Date.now(),
    };
    quizTemplates.set(templateId, template);

    const session = createSessionFromTemplate(template);

    persistQuizzes().catch((error) => {
      /* eslint-disable no-console */
      console.error('Failed to save quiz to disk', error);
    });

    socket.join(`${QUIZ_ROOM_PREFIX}${session.id}`);
    socket.emit('host:quizCreated', { quizId: session.id, templateId });
  });

  socket.on('host:claimHost', ({ quizId }) => {
    const lookupId = quizId?.trim()?.toUpperCase();
    if (!lookupId) {
      socket.emit('host:error', 'Please enter a quiz code.');
      return;
    }

    let session = sessions.get(lookupId);
    if (!session) {
      const template = quizTemplates.get(lookupId);
      if (!template) {
        socket.emit('host:error', 'Unable to find quiz with that code.');
        return;
      }
      session = createSessionFromTemplate(template, socket.id);
    }

    if (session.hostId && session.hostId !== socket.id) {
      socket.emit('host:error', 'Another host is already controlling this quiz.');
      return;
    }

    session.hostId = socket.id;
    socket.join(`${QUIZ_ROOM_PREFIX}${session.id}`);
    socket.emit('host:claimed', {
      quizId: session.id,
      title: session.title,
      totalQuestions: session.questions.length,
      questionDuration: session.questionDuration,
      leaderboard: formatLeaderboard(session),
      currentQuestionIndex: session.currentQuestionIndex,
      questionActive: session.questionActive,
    });
    if (session.lobbyTimer && session.lobbyExpiresAt) {
      const remainingMs = session.lobbyExpiresAt - Date.now();
      if (remainingMs > 0) {
        socket.emit('quiz:countdown', { seconds: Math.ceil(remainingMs / 1000) });
      }
    }
  });

  socket.on('player:join', ({ quizId, name, playerId }) => {
    const session = sessions.get(quizId?.trim()?.toUpperCase());
    if (!session) {
      socket.emit('player:error', 'Quiz not found. Double check the code.');
      return;
    }

    const persistentId = playerId?.trim() || nanoid();
    let player = session.players.get(persistentId);
    const displayName = name?.trim() || player?.name;

    if (!displayName) {
      socket.emit('player:error', 'Please enter your name.');
      return;
    }

    if (!player) {
      player = {
        id: persistentId,
        name: displayName,
        score: 0,
        socketId: null,
        disconnectedAt: null,
        disconnectTimer: null,
      };
      session.players.set(persistentId, player);
    } else {
      player.name = displayName;
    }

    bindPlayerToSocket(session, player, socket);

    socket.emit('player:joined', {
      quizId: session.id,
      title: session.title,
      totalQuestions: session.questions.length,
      questionDuration: session.questionDuration,
      playerId: player.id,
    });
    if (session.hostId) {
      io.to(session.hostId).emit('host:playerJoined', formatLeaderboard(session));
    }
    emitLeaderboard(session.id);

    const activePlayerCount = countConnectedPlayers(session);
    if (activePlayerCount === 1 && session.currentQuestionIndex === -1 && !session.lobbyTimer) {
      session.lobbyExpiresAt = Date.now() + 15000;
      session.lobbyTimer = setTimeout(() => startQuestion(session.id), 15000);
      io.to(`${QUIZ_ROOM_PREFIX}${session.id}`).emit('quiz:countdown', { seconds: 15 });
    } else if (session.lobbyTimer && session.lobbyExpiresAt) {
      const remainingMs = session.lobbyExpiresAt - Date.now();
      if (remainingMs > 0) {
        socket.emit('quiz:countdown', { seconds: Math.ceil(remainingMs / 1000) });
      }
    }

    socket.emit('player:state', buildPlayerState(session, player.id));
  });

  socket.on('host:startQuestion', ({ quizId }) => {
    const session = sessions.get(quizId?.trim()?.toUpperCase());
    if (!session || session.hostId !== socket.id) return;

    startQuestion(quizId);
  });

  socket.on('player:requestState', ({ quizId, playerId }) => {
    const session = sessions.get(quizId?.trim()?.toUpperCase());
    if (!session) {
      socket.emit('player:error', 'Quiz not found.');
      return;
    }

    const player = session.players.get(playerId?.trim());
    if (!player) {
      socket.emit('player:error', 'Player session expired. Please rejoin.');
      return;
    }

    bindPlayerToSocket(session, player, socket);
    socket.emit('player:state', buildPlayerState(session, player.id));
  });

  socket.on('player:answer', ({ quizId, answer }) => {
    const mapping = socketToPlayer.get(socket.id);
    if (!mapping) return;

    const session = sessions.get(mapping.sessionId);
    if (!session || session.id !== quizId?.trim()?.toUpperCase() || !session.questionActive)
      return;
    const player = session.players.get(mapping.playerId);
    if (!player || session.answers.has(player.id)) return;

    const submitted = answer ?? '';
    const currentQuestion = session.questions[session.currentQuestionIndex];
    const elapsedMs = Date.now() - session.questionStart;
    const durationMs = session.questionDuration * 1000;
    const timeRemaining = Math.max(0, durationMs - elapsedMs);

    const expectedAnswers = [currentQuestion.answer, ...(currentQuestion.alternateAnswers || [])];
    const isCorrect = expectedAnswers.some((expected) => normalise(submitted) === normalise(expected));
    let earned = 0;
    if (isCorrect) {
      const speedBonus = Math.round((timeRemaining / durationMs) * 500);
      earned = 1000 + speedBonus;
      player.score += earned;
    }

    session.answers.add(player.id);
    socket.emit('player:answerResult', {
      correct: isCorrect,
      earned,
      correctAnswer: currentQuestion.answer,
    });

    emitLeaderboard(session.id);
  });

  socket.on('host:endQuestion', ({ quizId }) => {
    const session = sessions.get(quizId?.trim()?.toUpperCase());
    if (!session || session.hostId !== socket.id) return;

    endQuestion(quizId);
  });

  socket.on('host:updateDuration', ({ quizId, duration }) => {
    const session = sessions.get(quizId?.trim()?.toUpperCase());
    if (!session || session.hostId !== socket.id) return;

    const parsed = Number(duration);
    if (!Number.isFinite(parsed) || parsed < 5 || parsed > 300) {
      socket.emit('host:error', 'Please enter a duration between 5 and 300 seconds.');
      return;
    }

    session.questionDuration = parsed;
    socket.emit('host:durationUpdated', { duration: parsed });
    io.to(`${QUIZ_ROOM_PREFIX}${quizId}`).emit('quiz:durationChanged', { duration: parsed });
  });

  socket.on('disconnect', () => {
    for (const [sessionId, session] of sessions) {
      if (session.hostId === socket.id) {
        io.to(`${QUIZ_ROOM_PREFIX}${sessionId}`).emit('quiz:ended');
        clearQuestionState(session);
        if (session.lobbyTimer) {
          clearTimeout(session.lobbyTimer);
          session.lobbyTimer = null;
          session.lobbyExpiresAt = null;
        }
        session.hostId = null;
      }
    }

    const mapping = socketToPlayer.get(socket.id);
    if (mapping) {
      const session = sessions.get(mapping.sessionId);
      const player = session?.players.get(mapping.playerId);
      if (session && player) {
        player.socketId = null;
        player.disconnectedAt = Date.now();
        schedulePlayerRemoval(session.id, player.id);
      }
      socketToPlayer.delete(socket.id);
    }
  });
});

app.use(express.static('public'));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/quizzes', (_req, res) => {
  const payload = Array.from(quizTemplates.values())
    .map((quiz) => ({
      id: quiz.id,
      title: quiz.title,
      questionCount: quiz.questions.length,
      createdAt: quiz.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);

  res.json(payload);
});

server.listen(PORT, HOST, () => {
  /* eslint-disable no-console */
  console.log(`Quiz server listening on http://${HOST}:${PORT}`);
});

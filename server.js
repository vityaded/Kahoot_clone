import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { customAlphabet, nanoid } from 'nanoid';
import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'quizzes.json');
const ASSIGNMENTS_FILE = path.join(DATA_DIR, 'assignments.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const QUIZ_ROOM_PREFIX = 'quiz-';
const DISCONNECT_GRACE_MS = 10000;

const quizTemplates = new Map();
const assignments = new Map();
const sessions = new Map();
const playerSessions = new Map();
const generateQuizCode = customAlphabet('0123456789', 6);
const generateAssignmentCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 8);
const synonymCache = new Map();

function normalizeAssignmentId(id) {
  return id?.trim()?.toUpperCase() || null;
}

function getAssignmentById(id) {
  const normalized = normalizeAssignmentId(id);
  if (!normalized) return null;
  return assignments.get(normalized) || null;
}

app.use(express.json());

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

function serializeAssignmentsForStorage() {
  return Array.from(assignments.values()).map((assignment) => ({
    ...assignment,
    submissions: assignment.submissions || [],
  }));
}

async function persistAssignments() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(serializeAssignmentsForStorage());
  await fs.writeFile(ASSIGNMENTS_FILE, payload, 'utf8');
}

async function loadPersistedAssignments() {
  try {
    const file = await fs.readFile(ASSIGNMENTS_FILE, 'utf8');
    const stored = JSON.parse(file);
    stored.forEach((assignment) => {
      const normalizedId = normalizeAssignmentId(assignment.id);
      if (!normalizedId) return;
      assignments.set(normalizedId, {
        ...assignment,
        id: normalizedId,
        submissions: assignment.submissions || [],
      });
    });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      /* eslint-disable no-console */
      console.error('Failed to load assignments from disk', error);
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

function calculateQuestionDuration(prompt = '', baseSeconds = 20) {
  const trimmed = prompt.trim();
  if (!trimmed) return baseSeconds;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const extraSeconds = Math.floor(wordCount / 2) * 10;
  return baseSeconds + extraSeconds;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[a.length][b.length];
}

function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const distance = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length) || 1;
  return 1 - distance / maxLen;
}

function isCloseMatch(submitted, expected) {
  const distance = levenshtein(submitted, expected);
  const maxLen = Math.max(submitted.length, expected.length) || 1;
  const closeness = 1 - distance / maxLen;

  if (closeness >= 0.8) return true;
  if (distance === 1 && Math.min(submitted.length, expected.length) >= 3) return true;
  if (distance === 2 && maxLen >= 6 && closeness >= 0.7) return true;

  if (submitted.length >= 5 && expected.includes(submitted)) return true;
  if (expected.length >= 5 && submitted.includes(expected)) return true;

  return false;
}

async function fetchSynonyms(word) {
  const normalized = normalise(word);
  if (!normalized) return [];
  if (synonymCache.has(normalized)) return synonymCache.get(normalized);

  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(normalized)}`);
    if (!response.ok) {
      synonymCache.set(normalized, []);
      return [];
    }

    const payload = await response.json();
    const synonyms = new Set();
    payload?.forEach((entry) => {
      entry?.meanings?.forEach((meaning) => {
        meaning?.synonyms?.forEach((syn) => synonyms.add(normalise(syn)));
        meaning?.definitions?.forEach((definition) => {
          definition?.synonyms?.forEach((syn) => synonyms.add(normalise(syn)));
        });
      });
    });

    const result = Array.from(synonyms).filter(Boolean);
    synonymCache.set(normalized, result);
    return result;
  } catch (_error) {
    synonymCache.set(normalized, []);
    return [];
  }
}

async function scoreAssignmentSubmission(assignment, answers = []) {
  let score = 0;
  let correctCount = 0;
  let partialCount = 0;

  // Normalize answers length to question count
  const submitted = assignment.questions.map((_, index) => normalise(answers[index] || ''));

  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < assignment.questions.length; i += 1) {
    const question = assignment.questions[i];
    const normalizedExpected = [
      question.answer,
      ...(Array.isArray(question.alternateAnswers) ? question.alternateAnswers : []),
    ]
      .map(normalise)
      .filter(Boolean);
    const normalizedPartial = (question.partialAnswers || []).map(normalise).filter(Boolean);

    const synonyms = Array.from(
      new Set(
        (
          await Promise.all(normalizedExpected.map((expected) => fetchSynonyms(expected)))
        )
          .flat()
          .filter(Boolean),
      ),
    );

    const submission = submitted[i];
    const isCorrect = normalizedExpected.includes(submission);
    const isPartial =
      !isCorrect &&
      (normalizedPartial.includes(submission) ||
        synonyms.includes(submission) ||
        synonyms.some((syn) => isCloseMatch(submission, syn)) ||
        normalizedExpected.some((expected) => isCloseMatch(submission, expected)));

    if (isCorrect) {
      score += 1000;
      correctCount += 1;
    } else if (isPartial) {
      score += 500;
      partialCount += 1;
    }
  }
  /* eslint-enable no-await-in-loop */

  const fraction = (correctCount + partialCount * 0.5) / (assignment.questions.length || 1);

  return {
    score,
    correctCount,
    partialCount,
    percent: Math.round(fraction * 100),
  };
}

function calculateAccuracy(player) {
  const answered = player.answeredQuestions || 0;
  if (!answered) return 0;
  const weightedCorrect = (player.correctAnswers || 0) + (player.partialAnswers || 0) * 0.5;
  return Math.round((weightedCorrect / answered) * 100);
}

function formatLeaderboard(session) {
  return Array.from(session.players.values())
    .sort((a, b) => b.score - a.score)
    .map((player) => ({
      name: player.name,
      score: player.score,
      accuracy: calculateAccuracy(player),
    }));
}

function createAssignmentFromQuiz(quizId, assignmentTitle = '') {
  const template = quizTemplates.get(quizId);
  if (!template) return null;

  const assignmentId = normalizeAssignmentId(generateAssignmentCode());
  if (!assignmentId) return null;
  const assignment = {
    id: assignmentId,
    quizId: template.id,
    quizTitle: template.title,
    assignmentTitle: assignmentTitle?.trim() || `${template.title} homework`,
    createdAt: Date.now(),
    questions: template.questions,
    submissions: [],
  };

  assignments.set(assignment.id, assignment);
  return assignment;
}

function summariseAssignment(assignment) {
  return {
    id: assignment.id,
    quizId: assignment.quizId,
    quizTitle: assignment.quizTitle,
    assignmentTitle: assignment.assignmentTitle,
    createdAt: assignment.createdAt,
    submissionCount: assignment.submissions.length,
    questionCount: assignment.questions.length,
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
}

function createSessionFromTemplate(template, hostId = null) {
  const sessionId = generateQuizCode();
  const baseQuestionDuration = Number(template.questionDuration) || 20;
  const session = {
    id: sessionId,
    templateId: template.id,
    hostId,
    title: template.title,
    players: new Map(),
    questions: template.questions,
    questionBaseDuration: baseQuestionDuration,
    questionDuration: baseQuestionDuration,
    currentQuestionIndex: -1,
    questionStart: null,
    answers: new Set(),
    questionActive: false,
    createdAt: Date.now(),
    questionTimer: null,
    leaderboardTimer: null,
    lobbyTimer: null,
    lobbyExpiresAt: null,
  };
  sessions.set(sessionId, session);
  return session;
}

function findPlayerBySocket(session, socketId) {
  for (const [playerId, player] of session.players) {
    if (player.socketId === socketId) {
      return { playerId, player };
    }
  }
  return null;
}

function calculateTimeRemaining(session) {
  if (!session.questionActive || !session.questionStart) return 0;
  const durationMs = session.questionDuration * 1000;
  const elapsedMs = Date.now() - session.questionStart;
  return Math.max(0, Math.ceil((durationMs - elapsedMs) / 1000));
}

function findPlayerSession(playerId, quizId = null) {
  const targetSessionId = quizId?.trim()?.toUpperCase() || playerSessions.get(playerId);
  if (!targetSessionId) return null;
  const session = sessions.get(targetSessionId);
  if (!session) return null;
  const player = session.players.get(playerId);
  if (!player) return null;
  return { sessionId: targetSessionId, session, player };
}

function emitPlayerState(socket, session, playerId = null) {
  const currentQuestion = session.questions[session.currentQuestionIndex];
  socket.emit('player:state', {
    quizId: session.id,
    title: session.title,
    totalQuestions: session.questions.length,
    questionDuration: session.questionDuration,
    leaderboard: formatLeaderboard(session),
    questionActive: session.questionActive,
    question: session.questionActive
      ? {
          prompt: currentQuestion.prompt,
          index: session.currentQuestionIndex + 1,
          total: session.questions.length,
          duration: session.questionDuration,
          media: currentQuestion.media,
        }
      : null,
    timeRemaining: calculateTimeRemaining(session),
    hasAnswered: playerId ? session.answers.has(playerId) : false,
  });

  if (session.lobbyTimer && session.lobbyExpiresAt) {
    const remainingMs = session.lobbyExpiresAt - Date.now();
    if (remainingMs > 0) {
      socket.emit('quiz:countdown', { seconds: Math.ceil(remainingMs / 1000) });
    }
  }
}

function scheduleLeaderboard(sessionId, { fastForward = false } = {}) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const leaderboard = formatLeaderboard(session);
  const hasMoreQuestions = session.currentQuestionIndex + 1 < session.questions.length;
  const pauseSeconds = 3;
  io.to(`${QUIZ_ROOM_PREFIX}${sessionId}`).emit('leaderboard:show', {
    leaderboard,
    duration: hasMoreQuestions ? pauseSeconds : null,
  });

  const leaderboardDelay = pauseSeconds * 1000;

  if (hasMoreQuestions) {
    session.leaderboardTimer = setTimeout(() => startQuestion(sessionId), leaderboardDelay);
  } else {
    session.leaderboardTimer = setTimeout(() => {
      io.to(`${QUIZ_ROOM_PREFIX}${sessionId}`).emit('quiz:finished');
    }, leaderboardDelay);
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
  session.answers = new Set();
  if (session.lobbyTimer) {
    clearTimeout(session.lobbyTimer);
    session.lobbyTimer = null;
    session.lobbyExpiresAt = null;
  }

  const currentQuestion = session.questions[nextIndex];
  const dynamicDuration = calculateQuestionDuration(currentQuestion.prompt, session.questionBaseDuration);
  session.questionDuration = dynamicDuration;
  io.to(`${QUIZ_ROOM_PREFIX}${sessionId}`).emit('question:start', {
    prompt: currentQuestion.prompt,
    index: nextIndex + 1,
    total: session.questions.length,
    duration: dynamicDuration,
    media: currentQuestion.media,
  });

  session.questionTimer = setTimeout(() => endQuestion(sessionId), dynamicDuration * 1000);
}

function endQuestion(sessionId, { fastForward = false } = {}) {
  const session = sessions.get(sessionId);
  if (!session || !session.questionActive) return;
  const currentQuestion = session.questions[session.currentQuestionIndex];
  clearQuestionState(session);
  io.to(`${QUIZ_ROOM_PREFIX}${sessionId}`).emit('question:end', {
    correctAnswer: currentQuestion?.answer,
  });
  scheduleLeaderboard(sessionId, { fastForward });
}

await loadPersistedQuizzes();
await loadPersistedAssignments();

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
        partialAnswers: Array.isArray(q.partialAnswers)
          ? q.partialAnswers.map((alt) => alt.trim()).filter(Boolean)
          : [],
        media: buildMediaPayload(q.media),
      }));
    if (!sanitizedQuestions.length) {
      socket.emit('host:error', 'Questions need both prompts and answers.');
      return;
    }

    const templateId = generateQuizCode();
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

    const displayName = name?.trim();
    if (!displayName) {
      socket.emit('player:error', 'Please enter your name.');
      return;
    }

    const resolvedPlayerId = playerId || nanoid(10);
    const existingPlayer = session.players.get(resolvedPlayerId);

    const previousSessionId = playerSessions.get(resolvedPlayerId);
    if (previousSessionId && previousSessionId !== session.id) {
      const previousSession = sessions.get(previousSessionId);
      previousSession?.players.delete(resolvedPlayerId);
    }

    if (existingPlayer) {
      if (existingPlayer.disconnectTimer) {
        clearTimeout(existingPlayer.disconnectTimer);
        existingPlayer.disconnectTimer = null;
      }
      existingPlayer.socketId = socket.id;
      existingPlayer.name = displayName;
    } else {
      session.players.set(resolvedPlayerId, {
        id: resolvedPlayerId,
        socketId: socket.id,
        name: displayName,
        score: 0,
        correctAnswers: 0,
        partialAnswers: 0,
        answeredQuestions: 0,
        disconnectTimer: null,
      });
    }

    playerSessions.set(resolvedPlayerId, session.id);

    socket.join(`${QUIZ_ROOM_PREFIX}${session.id}`);
    socket.emit('player:joined', {
      quizId: session.id,
      title: session.title,
      totalQuestions: session.questions.length,
      questionDuration: session.questionDuration,
      playerId: resolvedPlayerId,
    });
    emitPlayerState(socket, session, resolvedPlayerId);

    if (session.hostId) {
      io.to(session.hostId).emit('host:playerJoined', formatLeaderboard(session));
    }
    emitLeaderboard(session.id);

    if (session.players.size === 1 && session.currentQuestionIndex === -1 && !session.lobbyTimer) {
      session.lobbyExpiresAt = Date.now() + 15000;
      session.lobbyTimer = setTimeout(() => startQuestion(session.id), 15000);
      io.to(`${QUIZ_ROOM_PREFIX}${session.id}`).emit('quiz:countdown', { seconds: 15 });
    } else if (session.lobbyTimer && session.lobbyExpiresAt) {
      const remainingMs = session.lobbyExpiresAt - Date.now();
      if (remainingMs > 0) {
        socket.emit('quiz:countdown', { seconds: Math.ceil(remainingMs / 1000) });
      }
    }
  });

  socket.on('host:startQuestion', ({ quizId }) => {
    const session = sessions.get(quizId?.trim()?.toUpperCase());
    if (!session || session.hostId !== socket.id) return;

    startQuestion(quizId);
  });

  socket.on('player:reconnect', ({ playerId, quizId }) => {
    const found = findPlayerSession(playerId, quizId);
    if (!found) {
      socket.emit('player:reconnectFailed');
      return;
    }

    const { session, sessionId, player } = found;
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    player.socketId = socket.id;
    playerSessions.set(playerId, sessionId);

    socket.join(`${QUIZ_ROOM_PREFIX}${sessionId}`);
    socket.emit('player:reconnected', {
      quizId: sessionId,
      title: session.title,
      playerId,
      name: player.name,
      totalQuestions: session.questions.length,
      questionDuration: session.questionDuration,
    });

    emitPlayerState(socket, session, playerId);
    if (session.hostId) {
      io.to(session.hostId).emit('host:playerJoined', formatLeaderboard(session));
    }
  });

  socket.on('player:answer', async ({ quizId, answer }) => {
    const session = sessions.get(quizId?.trim()?.toUpperCase());
    if (!session || !session.questionActive) return;
    const found = findPlayerBySocket(session, socket.id);
    const player = found?.player;
    if (!player || session.answers.has(player.id)) return;

    const submitted = answer ?? '';
    const currentQuestion = session.questions[session.currentQuestionIndex];
    const elapsedMs = Date.now() - session.questionStart;
    const durationMs = session.questionDuration * 1000;
    const timeRemaining = Math.max(0, durationMs - elapsedMs);

    const expectedAnswers = [currentQuestion.answer, ...(currentQuestion.alternateAnswers || [])];
    const normalizedSubmitted = normalise(submitted);
    const normalizedExpected = expectedAnswers.map(normalise);
    const normalizedPartial = (currentQuestion.partialAnswers || []).map(normalise);

    const normalizedSynonyms = Array.from(
      new Set(
        (
          await Promise.all(
            expectedAnswers.map((expected) => fetchSynonyms(expected)),
          )
        )
          .flat()
          .filter(Boolean),
      ),
    );

    const isCorrect = normalizedExpected.some((expected) => normalizedSubmitted === expected);
    const isPartial =
      !isCorrect &&
      (normalizedPartial.includes(normalizedSubmitted) ||
        normalizedSynonyms.includes(normalizedSubmitted) ||
        normalizedSynonyms.some((syn) => isCloseMatch(normalizedSubmitted, syn)) ||
        normalizedExpected.some((expected) => isCloseMatch(normalizedSubmitted, expected)));
    let earned = 0;
    player.answeredQuestions = (player.answeredQuestions || 0) + 1;
    if (isCorrect || isPartial) {
      const speedBonus = Math.round((timeRemaining / durationMs) * 500);
      const baseScore = 1000 + speedBonus;
      earned = isCorrect ? baseScore : Math.round(baseScore / 2);
      player.score += earned;
      if (isCorrect) {
        player.correctAnswers = (player.correctAnswers || 0) + 1;
      } else {
        player.partialAnswers = (player.partialAnswers || 0) + 1;
      }
    }

    session.answers.add(player.id);
    socket.emit('player:answerResult', {
      correct: isCorrect,
      partial: isPartial,
      earned,
      correctAnswer: currentQuestion.answer,
      playerAnswer: submitted,
    });

    emitLeaderboard(session.id);

    const allPlayersAnswered = session.answers.size === session.players.size && session.players.size > 0;
    if (allPlayersAnswered) {
      if (session.questionTimer) {
        clearTimeout(session.questionTimer);
        session.questionTimer = null;
      }
      endQuestion(session.id, { fastForward: true });
    }
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

    session.questionBaseDuration = parsed;

    let updatedDuration = parsed;
    if (session.questionActive) {
      const currentQuestion = session.questions[session.currentQuestionIndex];
      updatedDuration = calculateQuestionDuration(currentQuestion?.prompt || '', session.questionBaseDuration);
      const elapsedMs = Date.now() - session.questionStart;
      const remainingMs = Math.max(updatedDuration * 1000 - elapsedMs, 0);
      session.questionDuration = updatedDuration;
      if (session.questionTimer) {
        clearTimeout(session.questionTimer);
      }
      session.questionTimer = setTimeout(() => endQuestion(session.id), remainingMs);
    } else {
      session.questionDuration = parsed;
    }

    socket.emit('host:durationUpdated', { duration: updatedDuration });
    io.to(`${QUIZ_ROOM_PREFIX}${quizId}`).emit('quiz:durationChanged', { duration: updatedDuration });
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
        continue;
      }

      const found = findPlayerBySocket(session, socket.id);
      if (found?.player) {
        const player = found.player;
        if (player.disconnectTimer) {
          clearTimeout(player.disconnectTimer);
        }
        player.disconnectTimer = setTimeout(() => {
          session.players.delete(found.playerId);
          playerSessions.delete(found.playerId);
          emitLeaderboard(sessionId);
          player.disconnectTimer = null;
        }, DISCONNECT_GRACE_MS);
      }
    }
  });
});

app.use(express.static('public'));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/quizzes/:quizId', (req, res) => {
  const quizId = req.params.quizId?.trim()?.toUpperCase();
  const quiz = quizTemplates.get(quizId);
  if (!quiz) {
    res.status(404).json({ error: 'Quiz not found' });
    return;
  }

  res.json({
    id: quiz.id,
    title: quiz.title,
    questionCount: quiz.questions.length,
    createdAt: quiz.createdAt,
  });
});

app.post('/api/quizzes/:quizId/assignments', (req, res) => {
  const quizId = req.params.quizId?.trim()?.toUpperCase();
  if (!quizTemplates.has(quizId)) {
    res.status(404).json({ error: 'Quiz not found' });
    return;
  }

  const assignment = createAssignmentFromQuiz(quizId, req.body?.title);
  if (!assignment) {
    res.status(500).json({ error: 'Unable to create assignment' });
    return;
  }
  persistAssignments().catch((error) => {
    /* eslint-disable no-console */
    console.error('Failed to persist assignments', error);
  });

  res.status(201).json(summariseAssignment(assignment));
});

app.get('/api/quizzes/:quizId/assignments', (req, res) => {
  const quizId = req.params.quizId?.trim()?.toUpperCase();
  if (!quizTemplates.has(quizId)) {
    res.status(404).json({ error: 'Quiz not found' });
    return;
  }

  const payload = Array.from(assignments.values())
    .filter((assignment) => assignment.quizId === quizId)
    .map(summariseAssignment)
    .sort((a, b) => b.createdAt - a.createdAt);

  res.json(payload);
});

app.get('/api/assignments/:assignmentId', (req, res) => {
  const assignment = getAssignmentById(req.params.assignmentId);
  if (!assignment) {
    res.status(404).json({ error: 'Assignment not found' });
    return;
  }

  const submissions = (assignment.submissions || [])
    .map((submission) => ({
      id: submission.id,
      playerName: submission.playerName,
      score: submission.score,
      percent: submission.percent,
      correct: submission.correct,
      partial: submission.partial,
      totalQuestions: submission.totalQuestions,
      submittedAt: submission.submittedAt,
    }))
    .sort((a, b) => b.submittedAt - a.submittedAt);

  res.json({
    ...summariseAssignment(assignment),
    submissions,
  });
});

app.get('/api/assignments/:assignmentId/take', (req, res) => {
  const assignment = getAssignmentById(req.params.assignmentId);
  if (!assignment) {
    res.status(404).json({ error: 'Assignment not found' });
    return;
  }

  res.json({
    id: assignment.id,
    quizId: assignment.quizId,
    quizTitle: assignment.quizTitle,
    assignmentTitle: assignment.assignmentTitle,
    createdAt: assignment.createdAt,
    questions: assignment.questions.map((question) => ({
      prompt: question.prompt,
      media: question.media,
    })),
  });
});

app.post('/api/assignments/:assignmentId/submit', async (req, res) => {
  const assignment = getAssignmentById(req.params.assignmentId);
  if (!assignment) {
    res.status(404).json({ error: 'Assignment not found' });
    return;
  }

  const playerName = req.body?.name?.trim();
  if (!playerName) {
    res.status(400).json({ error: 'Please provide your name.' });
    return;
  }

  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  const result = await scoreAssignmentSubmission(assignment, answers);
  const submission = {
    id: nanoid(8),
    playerName,
    score: result.score,
    percent: result.percent,
    correct: result.correctCount,
    partial: result.partialCount,
    totalQuestions: assignment.questions.length,
    submittedAt: Date.now(),
  };

  const existingIndex = assignment.submissions.findIndex(
    (entry) => normalise(entry.playerName) === normalise(playerName),
  );
  if (existingIndex >= 0) {
    assignment.submissions.splice(existingIndex, 1, submission);
  } else {
    assignment.submissions.push(submission);
  }

  persistAssignments().catch((error) => {
    /* eslint-disable no-console */
    console.error('Failed to persist assignments', error);
  });

  res.json({
    submission,
    message: 'Submission recorded',
  });
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

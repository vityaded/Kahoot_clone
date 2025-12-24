import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { customAlphabet, nanoid } from 'nanoid';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import multer from 'multer';
import {
  evaluateAnswer,
  normalise,
  normaliseAnswer,
  scoreSubmission,
} from './server/evaluation.js';
import {
  getAnswerStrictness,
  getLlmConfigOverrides,
  getLlmFallbackEnabled,
  getLlmPrimaryEnabled,
  getRuleMatchingConfig,
  loadSettings,
  parseAnswerStrictness,
  parseLlmFallbackEnabled,
  parseLlmPrimaryEnabled,
  saveAnswerStrictness,
  saveLlmFallbackEnabled,
  saveLlmPrimaryEnabled,
  saveSettings,
} from './server/settings.js';
import {
  DATA_DIR,
  DATA_FILE,
  HOMEWORK_FILE,
  LIVE_SESSIONS_FILE,
  MEDIA_DIR,
  ensureDataDir,
  ensureMediaDir,
} from './server/storage.js';
import { importApkgFromPath } from './server/importApkg.js';
import { fileURLToPath } from 'url';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const QUIZ_ROOM_PREFIX = 'quiz-';
const DISCONNECT_PRUNE_MS = 45 * 60 * 1000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const quizTemplates = new Map();
const sessions = new Map();
const playerSessions = new Map();
const homeworkSessions = new Map();
const generateQuizCode = customAlphabet('0123456789', 6);

app.use(express.json());

app.get('/api/settings/answer-strictness', (_req, res) => {
  res.json({
    strictness: getAnswerStrictness(),
    ruleConfig: getRuleMatchingConfig(),
    llmDefaults: getLlmConfigOverrides(),
    llmFallbackEnabled: getRuleMatchingConfig().allowLLMFallback,
    llmFallbackOverride: getLlmFallbackEnabled(),
    llmPrimaryEnabled: getLlmPrimaryEnabled(),
  });
});

app.post('/api/settings/answer-strictness', async (req, res) => {
  const hasStrictness = req.body?.strictness !== undefined;
  const hasLlmFallback = req.body?.llmFallbackEnabled !== undefined;
  const hasLlmPrimary = req.body?.llmPrimaryEnabled !== undefined;
  const normalizedStrictness = hasStrictness ? parseAnswerStrictness(req.body?.strictness) : null;
  const normalizedLlmFallback = hasLlmFallback ? parseLlmFallbackEnabled(req.body?.llmFallbackEnabled) : null;
  const normalizedLlmPrimary = hasLlmPrimary ? parseLlmPrimaryEnabled(req.body?.llmPrimaryEnabled) : null;

  if (!hasStrictness && !hasLlmFallback && !hasLlmPrimary) {
    res.status(400).json({ error: 'Provide strictness or LLM setting.' });
    return;
  }

  if (hasStrictness && !normalizedStrictness) {
    res.status(400).json({ error: 'Strictness must be strict, normal, or lenient.' });
    return;
  }

  if (hasLlmFallback && normalizedLlmFallback === null) {
    res.status(400).json({ error: 'LLM fallback must be true or false.' });
    return;
  }

  if (hasLlmPrimary && normalizedLlmPrimary === null) {
    res.status(400).json({ error: 'LLM primary must be true or false.' });
    return;
  }

  try {
    if (hasStrictness && (hasLlmFallback || hasLlmPrimary)) {
      await saveSettings({
        strictness: normalizedStrictness,
        llmFallbackEnabled: hasLlmFallback ? normalizedLlmFallback : undefined,
        llmPrimaryEnabled: hasLlmPrimary ? normalizedLlmPrimary : undefined,
      });
    } else if (hasStrictness) {
      await saveAnswerStrictness(normalizedStrictness);
    } else if (hasLlmFallback) {
      await saveLlmFallbackEnabled(normalizedLlmFallback);
    } else if (hasLlmPrimary) {
      await saveLlmPrimaryEnabled(normalizedLlmPrimary);
    }
    res.json({
      strictness: getAnswerStrictness(),
      ruleConfig: getRuleMatchingConfig(),
      llmDefaults: getLlmConfigOverrides(),
      llmFallbackEnabled: getRuleMatchingConfig().allowLLMFallback,
      llmFallbackOverride: getLlmFallbackEnabled(),
      llmPrimaryEnabled: getLlmPrimaryEnabled(),
    });
  } catch (error) {
    /* eslint-disable no-console */
    console.error('Failed to save strictness settings', error);
    res.status(500).json({ error: 'Unable to save strictness settings right now.' });
  }
});

app.post('/api/test-evaluate', async (req, res) => {
  const prompt = String(req.body?.prompt ?? '').trim();
  const answer = String(req.body?.answer ?? '').trim();
  const submission = String(req.body?.submission ?? '').trim();
  const alternateAnswers = Array.isArray(req.body?.alternateAnswers) ? req.body.alternateAnswers : [];
  const partialAnswers = Array.isArray(req.body?.partialAnswers) ? req.body.partialAnswers : [];

  if (!answer || !submission) {
    res.status(400).json({ error: 'Answer and submission are required.' });
    return;
  }

  try {
    const question = {
      prompt,
      answer,
      alternateAnswers: alternateAnswers.map((entry) => String(entry ?? '').trim()).filter(Boolean),
      partialAnswers: partialAnswers.map((entry) => String(entry ?? '').trim()).filter(Boolean),
    };
    const evaluation = await evaluateAnswer(question, submission, { includeSpeedBonus: false, debug: true });

    res.json({
      evaluation,
      question,
      normalized: {
        submitted: normaliseAnswer(submission),
        expected: [question.answer, ...question.alternateAnswers].map(normaliseAnswer),
        partial: question.partialAnswers.map(normaliseAnswer),
      },
      ruleConfig: getRuleMatchingConfig(),
    });
  } catch (error) {
    /* eslint-disable no-console */
    console.error('Failed to evaluate test answer', error);
    res.status(500).json({ error: 'Unable to evaluate answer right now.' });
  }
});

function serializeForStorage() {
  return Array.from(quizTemplates.values()).map((quiz) => ({
    id: quiz.id,
    title: quiz.title,
    questions: quiz.questions,
    questionDuration: quiz.questionDuration,
    createdAt: quiz.createdAt,
    source: quiz.source || null,
  }));
}

async function persistQuizzes() {
  await ensureDataDir();
  const payload = JSON.stringify(serializeForStorage());
  await fs.writeFile(DATA_FILE, payload, 'utf8');
}

async function loadPersistedQuizzes() {
  try {
    const file = await fs.readFile(DATA_FILE, 'utf8');
    const stored = JSON.parse(file);
    stored.forEach((quiz) => {
      if (!quiz?.id || !quiz?.questions) return;
      quizTemplates.set(quiz.id, {
        ...quiz,
        questionDuration: Number(quiz.questionDuration) || 20,
        createdAt: quiz.createdAt || Date.now(),
        source: quiz.source || null,
      });
    });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      /* eslint-disable no-console */
      console.error('Failed to load quizzes from disk', error);
    }
  }
}

function serializeHomeworkForStorage() {
  return Array.from(homeworkSessions.values()).map((session) => ({
    id: session.id,
    templateId: session.templateId,
    title: session.title,
    createdAt: session.createdAt,
    dueAt: session.dueAt,
    questionDuration: session.questionDuration,
    submissions: Array.from(session.submissions.entries()).map(([key, payload]) => ({
      key,
      ...payload,
    })),
    questions: session.questions,
  }));
}

async function persistHomeworkSessions() {
  await ensureDataDir();
  const payload = JSON.stringify(serializeHomeworkForStorage());
  await fs.writeFile(HOMEWORK_FILE, payload, 'utf8');
}

async function loadPersistedHomeworkSessions() {
  try {
    const file = await fs.readFile(HOMEWORK_FILE, 'utf8');
    const stored = JSON.parse(file);
    stored.forEach((session) => {
      const template = quizTemplates.get(session.templateId);
      if (!template) return;

      const submissions = new Map();
      session.submissions?.forEach((entry) => {
        if (!entry?.key) return;
        submissions.set(entry.key, {
          name: entry.name,
          score: entry.score,
          attempts: entry.attempts,
          lastSubmitted: entry.lastSubmitted,
          responses: entry.responses,
        });
      });

      homeworkSessions.set(session.id, {
        id: session.id,
        templateId: session.templateId,
        title: session.title,
        createdAt: session.createdAt,
        dueAt: session.dueAt,
        submissions,
        questions: session.questions,
        questionDuration: session.questionDuration,
      });
    });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      /* eslint-disable no-console */
      console.error('Failed to load homework sessions from disk', error);
    }
  }
}

function serializeLiveSessions() {
  return Array.from(sessions.values()).map((session) => ({
    id: session.id,
    templateId: session.templateId,
    title: session.title,
    hostId: session.hostId || null,
    createdAt: session.createdAt,
    questionActive: session.questionActive,
    currentQuestionIndex: session.currentQuestionIndex,
    questionStart: session.questionStart,
    answers: Array.from(session.answers || []),
    questionDuration: session.questionDuration,
    runSettings: session.runSettings,
    runSettingsConfirmed: session.runSettingsConfirmed,
    questions: session.questions,
    players: Array.from(session.players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      lastSeen: player.lastSeen,
      socketId: null,
    })),
  }));
}

async function persistLiveSessions() {
  await ensureDataDir();
  const payload = JSON.stringify(serializeLiveSessions());
  await fs.writeFile(LIVE_SESSIONS_FILE, payload, 'utf8');
}

async function loadPersistedLiveSessions() {
  try {
    const file = await fs.readFile(LIVE_SESSIONS_FILE, 'utf8');
    const stored = JSON.parse(file);
    stored.forEach((entry) => {
      if (!entry?.id || !entry?.templateId) return;
      const template = quizTemplates.get(entry.templateId);
      if (!template) return;

      const players = new Map();
      entry.players?.forEach((player) => {
        if (!player?.id) return;
        players.set(player.id, {
          id: player.id,
          socketId: null,
          name: player.name || '',
          score: Number(player.score) || 0,
          disconnectTimer: null,
          isConnected: false,
          disconnectedAt: null,
          lastSeen: player.lastSeen || null,
        });
        playerSessions.set(player.id, entry.id);
      });

      sessions.set(entry.id, {
        id: entry.id,
        templateId: entry.templateId,
        hostId: null,
        title: entry.title || template.title,
        players,
        baseQuestions: template.questions,
        baseQuestionCount: template.questions.length,
        questions: Array.isArray(entry.questions) && entry.questions.length ? entry.questions : template.questions,
        runSettings: entry.runSettings || { count: template.questions.length, shuffle: false },
        runSettingsConfirmed: typeof entry.runSettingsConfirmed === 'boolean'
          ? entry.runSettingsConfirmed
          : template.questions.length <= 10,
        questionDuration: Number(entry.questionDuration) || template.questionDuration,
        currentQuestionIndex: Number.isInteger(entry.currentQuestionIndex) ? entry.currentQuestionIndex : -1,
        questionStart: null,
        answers: new Set(Array.isArray(entry.answers) ? entry.answers : []),
        questionActive: false,
        createdAt: entry.createdAt || Date.now(),
        questionTimer: null,
        leaderboardTimer: null,
        lobbyTimer: null,
        lobbyExpiresAt: null,
      });
    });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      /* eslint-disable no-console */
      console.error('Failed to load live sessions from disk', error);
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

function formatLeaderboard(session) {
  return Array.from(session.players.values())
    .sort((a, b) => b.score - a.score)
    .map(({ name, score }) => ({ name, score }));
}

function formatHomeworkLeaderboard(session) {
  return Array.from(session.submissions.values()).sort((a, b) => b.score - a.score);
}

function countConnectedPlayers(session) {
  let count = 0;
  for (const player of session.players.values()) {
    if (player.isConnected) count += 1;
  }
  return count;
}

function pruneDisconnectedPlayers(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  for (const [playerId, player] of session.players) {
    if (player.isConnected) continue;
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    session.players.delete(playerId);
    playerSessions.delete(playerId);
  }
  emitLeaderboard(sessionId);
}

function sanitizeQuestions(rawQuestions = []) {
  return rawQuestions
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
    }))
    .filter((q) => q.prompt && q.answer);
}

function collectMediaSrcsFromQuestions(questions = []) {
  const out = new Set();
  for (const q of questions) {
    const src = q?.media?.src;
    if (src && typeof src === 'string') out.add(src);
  }
  return out;
}

function createQuizTemplate({ title, questions, questionDuration, sourceMeta = null }) {
  const sanitizedQuestions = sanitizeQuestions(questions);
  if (!sanitizedQuestions.length) {
    return null;
  }

  let templateId;
  do {
    templateId = generateQuizCode();
  } while (quizTemplates.has(templateId));

  const template = {
    id: templateId,
    title: title?.trim() || 'Classroom Quiz',
    questions: sanitizedQuestions,
    questionDuration: Number(questionDuration) || 20,
    createdAt: Date.now(),
  };

  if (sourceMeta) {
    template.source = sourceMeta;
  }

  quizTemplates.set(templateId, template);
  persistQuizzes().catch((error) => {
    /* eslint-disable no-console */
    console.error('Failed to save quiz to disk', error);
  });

  return template;
}

function createHomeworkSession(template, { dueAt = null } = {}) {
  const questions = template.questions.map((question) => {
    const text = question.answer?.trim() || question.prompt?.trim() || '';
    const wordCount = Math.max(text.split(/\s+/).filter(Boolean).length || 0, 1);
    const duration = 20 + 10 * (wordCount - 1);

    return { ...question, duration };
  });

  const homeworkId = generateQuizCode();
  const session = {
    id: homeworkId,
    templateId: template.id,
    title: template.title,
    createdAt: Date.now(),
    dueAt: dueAt && Number.isFinite(dueAt) ? dueAt : null,
    submissions: new Map(),
    questions,
    questionDuration: template.questionDuration,
  };
  homeworkSessions.set(homeworkId, session);
  persistHomeworkSessions().catch((error) => {
    /* eslint-disable no-console */
    console.error('Failed to save homework to disk', error);
  });
  return session;
}

function findHomeworkSession(homeworkId) {
  if (!homeworkId) return null;
  return homeworkSessions.get(homeworkId.trim().toUpperCase()) || null;
}

async function evaluateHomeworkSubmission(session, answers = []) {
  const template = quizTemplates.get(session.templateId);
  if (!template) return { score: 0, responses: [] };

  const evaluation = await scoreSubmission(template.questions, Array.isArray(answers) ? answers : [], {
    includeSpeedBonus: false,
  });
  return evaluation;
}

async function scoreHomeworkSubmission(session, answers = []) {
  const evaluation = await evaluateHomeworkSubmission(session, answers);
  return evaluation.score;
}

async function recordHomeworkSubmission(session, name, answers = []) {
  if (!name?.trim()) return null;
  const evaluation = await evaluateHomeworkSubmission(session, answers);
  const score = evaluation.score;
  const key = normalise(name) || name;
  const existing = session.submissions.get(key);
  const payload = {
    name: name.trim(),
    score: existing ? Math.max(existing.score, score) : score,
    attempts: (existing?.attempts || 0) + 1,
    lastSubmitted: Date.now(),
    responses: evaluation.responses,
  };
  session.submissions.set(key, payload);
  try {
    await persistHomeworkSessions();
  } catch (error) {
    /* eslint-disable no-console */
    console.error('Failed to save homework submission', error);
  }
  return payload;
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

function destroySession(sessionId, reason = 'deleted') {
  const session = sessions.get(sessionId);
  if (!session) return;

  clearQuestionState(session);
  if (session.lobbyTimer) {
    clearTimeout(session.lobbyTimer);
    session.lobbyTimer = null;
    session.lobbyExpiresAt = null;
  }

  for (const [playerId, player] of session.players) {
    if (player?.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    playerSessions.delete(playerId);
  }

  io.to(`${QUIZ_ROOM_PREFIX}${sessionId}`).emit('quiz:terminated', { reason });

  sessions.delete(sessionId);
  persistLiveSessions().catch((error) => {
    /* eslint-disable no-console */
    console.error('Failed to save live sessions', error);
  });
}

function deleteHomeworkForTemplate(templateId) {
  const deletedIds = [];
  for (const [hwId, hw] of homeworkSessions) {
    if (hw?.templateId === templateId) {
      homeworkSessions.delete(hwId);
      deletedIds.push(hwId);
    }
  }
  return deletedIds;
}

async function garbageCollectMedia(candidateSrcs = new Set()) {
  if (!candidateSrcs.size) return;

  const used = new Set();

  for (const quiz of quizTemplates.values()) {
    collectMediaSrcsFromQuestions(quiz.questions).forEach((s) => used.add(s));
  }

  for (const hw of homeworkSessions.values()) {
    collectMediaSrcsFromQuestions(hw.questions).forEach((s) => used.add(s));
  }

  const mediaDir = path.join(DATA_DIR, 'media');

  for (const src of candidateSrcs) {
    if (used.has(src)) continue;
    if (!src.startsWith('/media/')) continue;

    const fileName = path.basename(src);
    const absPath = path.join(mediaDir, fileName);

    if (!absPath.startsWith(mediaDir)) continue;

    try { await fs.unlink(absPath); } catch (e) { /* ignore */ }
  }
}

function shuffleInPlace(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function buildRunQuestions(baseQuestions, { count, shuffle } = {}) {
  const cloned = Array.isArray(baseQuestions) ? baseQuestions.slice() : [];
  const max = cloned.length;
  let desired = Number.parseInt(count, 10);

  if (!Number.isFinite(desired) || desired <= 0) desired = max;
  desired = Math.max(1, Math.min(desired, max));

  if (shuffle) shuffleInPlace(cloned);
  return cloned.slice(0, desired);
}

function createSessionFromTemplate(template, hostId = null) {
  const sessionId = generateQuizCode();
  const session = {
    id: sessionId,
    templateId: template.id,
    hostId,
    title: template.title,
    players: new Map(),
    baseQuestions: template.questions,
    baseQuestionCount: template.questions.length,
    questions: template.questions,
    runSettings: { count: template.questions.length, shuffle: false },
    runSettingsConfirmed: template.questions.length <= 10,
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
  const currentDuration = resolveQuestionDuration(session);
  const durationMs = currentDuration * 1000;
  const elapsedMs = Date.now() - session.questionStart;
  return Math.max(0, Math.ceil((durationMs - elapsedMs) / 1000));
}

function resolveQuestionDuration(session, index = null) {
  const questionIndex = Number.isInteger(index) ? index : session.currentQuestionIndex;
  const questionDuration = session.questions?.[questionIndex]?.duration;
  const parsedDuration = Number(questionDuration);
  if (Number.isFinite(parsedDuration) && parsedDuration > 0) return parsedDuration;
  return session.questionDuration;
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
  const questionDuration = resolveQuestionDuration(session);
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
          duration: questionDuration,
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
      pruneDisconnectedPlayers(sessionId);
    }, leaderboardDelay);
  }
}

function startQuestion(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.hostId && session.baseQuestionCount > 10 && !session.runSettingsConfirmed && session.currentQuestionIndex === -1) {
    io.to(session.hostId).emit('host:error', 'Choose how many questions to use (and optionally shuffle) before starting.');
    return;
  }

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
  const questionDuration = resolveQuestionDuration(session, nextIndex);
  io.to(`${QUIZ_ROOM_PREFIX}${sessionId}`).emit('question:start', {
    prompt: currentQuestion.prompt,
    index: nextIndex + 1,
    total: session.questions.length,
    duration: questionDuration,
    media: currentQuestion.media,
  });

  session.questionTimer = setTimeout(() => endQuestion(sessionId), questionDuration * 1000);
  persistLiveSessions().catch((error) => {
    /* eslint-disable no-console */
    console.error('Failed to save live sessions', error);
  });
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
  persistLiveSessions().catch((error) => {
    /* eslint-disable no-console */
    console.error('Failed to save live sessions', error);
  });
}

await ensureDataDir();
await ensureMediaDir();
await loadSettings();
await loadPersistedQuizzes();
await loadPersistedHomeworkSessions();
await loadPersistedLiveSessions();

io.on('connection', (socket) => {
  socket.on('host:createQuiz', ({ title, questions, questionDuration }) => {
    try {
      if (!Array.isArray(questions) || questions.length === 0) {
        socket.emit('host:error', 'Please add at least one question.');
        return;
      }
      const template = createQuizTemplate({ title, questions, questionDuration });
      if (!template) {
        socket.emit('host:error', 'Questions need both prompts and answers.');
        return;
      }

      const session = createSessionFromTemplate(template);

      socket.join(`${QUIZ_ROOM_PREFIX}${session.id}`);
      socket.emit('host:quizCreated', { quizId: session.id, templateId: template.id });
    } catch (err) {
      console.error('host:createQuiz failed', err);
      socket.emit('host:error', 'Failed to create quiz due to a server error.');
    }
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

    session.baseQuestions = session.baseQuestions || session.questions;
    session.baseQuestionCount = session.baseQuestionCount || session.questions.length;
    session.runSettings = session.runSettings || { count: session.questions.length, shuffle: false };
    session.runSettingsConfirmed =
      typeof session.runSettingsConfirmed === 'boolean'
        ? session.runSettingsConfirmed
        : session.baseQuestionCount <= 10;

    session.hostId = socket.id;
    if (session.lobbyTimer) {
      clearTimeout(session.lobbyTimer);
      session.lobbyTimer = null;
      session.lobbyExpiresAt = null;
      io.to(`${QUIZ_ROOM_PREFIX}${session.id}`).emit('quiz:countdownCancelled');
    }

    socket.join(`${QUIZ_ROOM_PREFIX}${session.id}`);
    socket.emit('host:claimed', {
      quizId: session.id,
      title: session.title,
      totalQuestions: session.questions.length,
      baseTotalQuestions: session.baseQuestionCount || session.questions.length,
      runSettings: session.runSettings || { count: session.questions.length, shuffle: false },
      runSettingsConfirmed: !!session.runSettingsConfirmed,
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
    persistLiveSessions().catch((error) => {
      /* eslint-disable no-console */
      console.error('Failed to save live sessions', error);
    });
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
      existingPlayer.isConnected = true;
      existingPlayer.disconnectedAt = null;
      existingPlayer.lastSeen = Date.now();
      if (!existingPlayer.name) {
        existingPlayer.name = displayName;
      }
    } else {
      session.players.set(resolvedPlayerId, {
        id: resolvedPlayerId,
        socketId: socket.id,
        name: displayName,
        score: 0,
        disconnectTimer: null,
        isConnected: true,
        disconnectedAt: null,
        lastSeen: Date.now(),
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

    if (!session.hostId && countConnectedPlayers(session) === 1 && session.currentQuestionIndex === -1 && !session.lobbyTimer) {
      session.lobbyExpiresAt = Date.now() + 15000;
      session.lobbyTimer = setTimeout(() => startQuestion(session.id), 15000);
      io.to(`${QUIZ_ROOM_PREFIX}${session.id}`).emit('quiz:countdown', { seconds: 15 });
    } else if (session.lobbyTimer && session.lobbyExpiresAt) {
      const remainingMs = session.lobbyExpiresAt - Date.now();
      if (remainingMs > 0) {
        socket.emit('quiz:countdown', { seconds: Math.ceil(remainingMs / 1000) });
      }
    }
    persistLiveSessions().catch((error) => {
      /* eslint-disable no-console */
      console.error('Failed to save live sessions', error);
    });
  });

  socket.on('host:startQuestion', ({ quizId }) => {
    const session = sessions.get(quizId?.trim()?.toUpperCase());
    if (!session || session.hostId !== socket.id) return;

    startQuestion(quizId);
  });

  socket.on('host:configureRun', ({ quizId, count, shuffle }) => {
    const session = sessions.get(quizId?.trim()?.toUpperCase());
    if (!session) {
      socket.emit('host:error', 'Quiz not found. Double check the code.');
      return;
    }
    if (session.hostId !== socket.id) return;

    if (session.currentQuestionIndex !== -1 || session.questionActive) {
      socket.emit('host:error', 'You can only configure the run before starting.');
      return;
    }

    const base =
      session.baseQuestions ||
      quizTemplates.get(session.templateId)?.questions ||
      session.questions ||
      [];
    session.baseQuestions = Array.isArray(base) ? base : [];
    session.baseQuestionCount = session.baseQuestions.length;
    const questions = buildRunQuestions(session.baseQuestions, { count, shuffle: !!shuffle });

    session.questions = questions;
    session.runSettings = { count: questions.length, shuffle: !!shuffle };
    session.runSettingsConfirmed = true;

    session.currentQuestionIndex = -1;
    clearQuestionState(session);

    if (session.lobbyTimer) {
      clearTimeout(session.lobbyTimer);
      session.lobbyTimer = null;
      session.lobbyExpiresAt = null;
      io.to(`${QUIZ_ROOM_PREFIX}${session.id}`).emit('quiz:countdownCancelled');
    }

    socket.emit('host:runConfigured', {
      totalQuestions: session.questions.length,
      baseTotalQuestions: base.length,
      runSettings: session.runSettings,
    });
    io.to(`${QUIZ_ROOM_PREFIX}${session.id}`).emit('quiz:meta', { totalQuestions: session.questions.length, title: session.title });
    persistLiveSessions().catch((error) => {
      /* eslint-disable no-console */
      console.error('Failed to save live sessions', error);
    });
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
    player.isConnected = true;
    player.disconnectedAt = null;
    player.lastSeen = Date.now();
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
    persistLiveSessions().catch((error) => {
      /* eslint-disable no-console */
      console.error('Failed to save live sessions', error);
    });
  });

  socket.on('player:answer', async ({ quizId, answer }) => {
    const session = sessions.get(quizId?.trim()?.toUpperCase());
    if (!session || !session.questionActive) return;
    const found = findPlayerBySocket(session, socket.id);
    const player = found?.player;
    if (!player || session.answers.has(player.id)) return;

    const submitted = answer ?? '';
    const currentQuestion = session.questions[session.currentQuestionIndex];
    player.lastSeen = Date.now();
    const elapsedMs = Date.now() - session.questionStart;
    const questionDuration = resolveQuestionDuration(session);
    const durationMs = questionDuration * 1000;
    const timeRemaining = Math.max(0, durationMs - elapsedMs);
    const evaluation = await evaluateAnswer(currentQuestion, submitted, {
      durationMs,
      timeRemainingMs: timeRemaining,
      includeSpeedBonus: true,
    });

    player.score += evaluation.earned;

    session.answers.add(player.id);
    socket.emit('player:answerResult', {
      correct: evaluation.isCorrect,
      partial: evaluation.isPartial,
      earned: evaluation.earned,
      correctAnswer: currentQuestion.answer,
      playerAnswer: submitted,
    });

    emitLeaderboard(session.id);

    const connectedIds = Array.from(session.players.values())
      .filter((entry) => entry.isConnected)
      .map((entry) => entry.id);
    const allPlayersAnswered =
      connectedIds.length > 0 && connectedIds.every((id) => session.answers.has(id));
    if (allPlayersAnswered) {
      if (session.questionTimer) {
        clearTimeout(session.questionTimer);
        session.questionTimer = null;
      }
      endQuestion(session.id, { fastForward: true });
    }
    persistLiveSessions().catch((error) => {
      /* eslint-disable no-console */
      console.error('Failed to save live sessions', error);
    });
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
    persistLiveSessions().catch((error) => {
      /* eslint-disable no-console */
      console.error('Failed to save live sessions', error);
    });
  });

  socket.on('disconnect', () => {
    let mutated = false;
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
        pruneDisconnectedPlayers(sessionId);
        mutated = true;
        continue;
      }

      const found = findPlayerBySocket(session, socket.id);
      if (found?.player) {
        const player = found.player;
        if (player.disconnectTimer) {
          clearTimeout(player.disconnectTimer);
        }
        player.isConnected = false;
        player.disconnectedAt = Date.now();
        player.lastSeen = Date.now();
        player.socketId = null;
        player.disconnectTimer = setTimeout(() => {
          if (player.isConnected) {
            player.disconnectTimer = null;
            return;
          }
          session.players.delete(found.playerId);
          playerSessions.delete(found.playerId);
          emitLeaderboard(sessionId);
          player.disconnectTimer = null;
        }, DISCONNECT_PRUNE_MS);
        mutated = true;
      }
    }
    if (mutated) {
      persistLiveSessions().catch((error) => {
        /* eslint-disable no-console */
        console.error('Failed to save live sessions', error);
      });
    }
  });
});

app.use(express.static('public'));
app.use('/media', express.static(MEDIA_DIR));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/test', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'test.html'));
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
    questionDuration: quiz.questionDuration,
    createdAt: quiz.createdAt,
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

app.delete('/api/quizzes/:quizId', async (req, res) => {
  const quizId = req.params.quizId?.trim()?.toUpperCase();
  const quiz = quizTemplates.get(quizId);

  if (!quiz) {
    res.status(404).json({ error: 'Quiz not found' });
    return;
  }

  const mediaCandidates = new Set();
  collectMediaSrcsFromQuestions(quiz.questions).forEach((s) => mediaCandidates.add(s));

  for (const hw of homeworkSessions.values()) {
    if (hw?.templateId === quizId) {
      collectMediaSrcsFromQuestions(hw.questions).forEach((s) => mediaCandidates.add(s));
    }
  }

  const sessionsToKill = [];
  for (const [sessionId, session] of sessions) {
    if (session?.templateId === quizId) sessionsToKill.push(sessionId);
  }
  sessionsToKill.forEach((id) => destroySession(id, 'deleted'));

  const deletedHomeworkIds = deleteHomeworkForTemplate(quizId);

  quizTemplates.delete(quizId);

  try {
    await persistQuizzes();
    await persistHomeworkSessions();
    await garbageCollectMedia(mediaCandidates);
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete quiz' });
    return;
  }

  res.json({
    ok: true,
    deletedQuizId: quizId,
    deletedLiveSessions: sessionsToKill.length,
    deletedHomework: deletedHomeworkIds.length,
  });
});

app.post('/api/homework', (req, res) => {
  const quizId = req.body?.quizId?.trim()?.toUpperCase();
  const dueAtRaw = req.body?.dueAt;
  const dueAt = dueAtRaw ? Date.parse(dueAtRaw) : null;
  const template = quizTemplates.get(quizId);

  if (!template) {
    res.status(404).json({ error: 'Quiz not found' });
    return;
  }

  const session = createHomeworkSession(template, { dueAt: Number.isFinite(dueAt) ? dueAt : null });
  res.json({
    id: session.id,
    title: session.title,
    quizId: session.templateId,
    createdAt: session.createdAt,
    dueAt: session.dueAt,
    questionCount: template.questions.length,
    leaderboard: formatHomeworkLeaderboard(session),
  });
});

app.get('/api/homework/:homeworkId', (req, res) => {
  const session = findHomeworkSession(req.params.homeworkId);
  if (!session) {
    res.status(404).json({ error: 'Homework not found' });
    return;
  }
  const template = quizTemplates.get(session.templateId);

  res.json({
    id: session.id,
    title: session.title,
    quizId: session.templateId,
    createdAt: session.createdAt,
    dueAt: session.dueAt,
    questionCount: template?.questions?.length || 0,
    questions: session.questions.map((question) => ({
      prompt: question.prompt,
      media: question.media,
      duration: question.duration,
    })),
    leaderboard: formatHomeworkLeaderboard(session),
  });
});

app.get('/api/homework/:homeworkId/leaderboard', (req, res) => {
  const session = findHomeworkSession(req.params.homeworkId);
  if (!session) {
    res.status(404).json({ error: 'Homework not found' });
    return;
  }
  res.json(formatHomeworkLeaderboard(session));
});

app.post('/api/homework/:homeworkId/evaluate', async (req, res) => {
  const session = findHomeworkSession(req.params.homeworkId);
  if (!session) {
    res.status(404).json({ error: 'Homework not found' });
    return;
  }

  const questionIndex = Number(req.body?.questionIndex);
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= session.questions.length) {
    res.status(400).json({ error: 'Invalid question index' });
    return;
  }

  const question = session.questions[questionIndex];
  const answer = req.body?.answer ?? '';
  const evaluation = await evaluateAnswer(question, answer, { includeSpeedBonus: false });

  res.json({
    isCorrect: evaluation.isCorrect,
    isPartial: evaluation.isPartial,
    correctAnswer: evaluation.correctAnswer,
    playerAnswer: evaluation.playerAnswer,
  });
});

app.post('/api/homework/:homeworkId/submit', async (req, res) => {
  const session = findHomeworkSession(req.params.homeworkId);
  if (!session) {
    res.status(404).json({ error: 'Homework not found' });
    return;
  }

  const { playerName, answers } = req.body || {};
  if (!playerName?.trim()) {
    res.status(400).json({ error: 'Player name required' });
    return;
  }

  const submission = await recordHomeworkSubmission(session, playerName, answers);
  const leaderboard = formatHomeworkLeaderboard(session);
  const review = (submission?.responses || [])
    .filter((entry) => !entry.isCorrect)
    .map((entry) => ({
      prompt: entry.prompt,
      submitted: entry.submitted,
      correctAnswer: entry.correctAnswer,
  }));
  res.json({ submission, leaderboard, review });
});

const apkgUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `apkg_${Date.now()}_${file.originalname}`),
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.originalname?.toLowerCase().endsWith('.apkg');
    cb(ok ? null : new Error('Only .apkg files are allowed'), ok);
  },
});

app.post('/api/quizzes/import/apkg', apkgUpload.single('apkg'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Please upload an .apkg file.' });
    return;
  }

  try {
    const importResult = await importApkgFromPath(req.file.path, req.file.originalname);
    const alreadyImported = Array.from(quizTemplates.values()).some(
      (template) => template.source?.sha256 && template.source.sha256 === importResult.sha256,
    );

    if (alreadyImported) {
      res.status(409).json({ error: 'This package has already been imported.' });
      return;
    }

    const created = [];
    importResult.templates.forEach((templateData) => {
      const template = createQuizTemplate({
        title: templateData.deckName || templateData.title || 'Imported deck',
        questions: templateData.questions,
        questionDuration: 20,
        sourceMeta: {
          type: 'apkg',
          sha256: importResult.sha256,
          deckId: templateData.deckId,
          deckName: templateData.deckName,
          fileName: req.file.originalname,
        },
      });
      if (template) {
        created.push({
          id: template.id,
          title: template.title,
          questionCount: template.questions.length,
        });
      }
    });

    if (!created.length) {
      res.status(400).json({ error: 'No quizzes could be created from this package.' });
      return;
    }

    res.json({ created, skipped: [] });
  } catch (error) {
    /* eslint-disable no-console */
    console.error('Failed to import apkg', error);
    res.status(500).json({ error: 'Failed to import the Anki package.' });
  } finally {
    if (req.file?.path) {
      try {
        await fs.unlink(req.file.path);
      } catch (cleanupError) {
        /* eslint-disable no-console */
        console.error('Failed to remove uploaded apkg', cleanupError);
      }
    }
  }
});

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Increase upload limit or upload a smaller .apkg.' });
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'Upload failed.' });
  }
  next();
});

server.listen(PORT, HOST, () => {
  /* eslint-disable no-console */
  console.log(`Quiz server listening on http://${HOST}:${PORT}`);
});

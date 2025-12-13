import { evaluateAnswer } from '../evaluation.js';
import { claimCards, recordBadCard, recordScore } from './storage.js';

const activeSessions = new Map();

export function getActiveSession(userId) {
  return activeSessions.get(userId) || null;
}

function stopSession(userId) {
  activeSessions.delete(userId);
}

export async function startSession(deck, userId, { limit = 10 } = {}) {
  const cards = await claimCards(deck.id, userId, limit);
  if (!cards.length) return null;

  const session = {
    deckId: deck.id,
    userId,
    cards,
    cursor: 0,
    score: 0,
    startedAt: Date.now(),
  };

  activeSessions.set(userId, session);
  return session;
}

export async function flagBadCard(userId, cardId) {
  const session = getActiveSession(userId);
  if (!session) return null;
  return recordBadCard(session.deckId, cardId, userId);
}

export async function submitAnswer(userId, answer) {
  const session = getActiveSession(userId);
  if (!session) return null;
  const current = session.cards[session.cursor];
  if (!current) return null;

  const evaluation = await evaluateAnswer(
    { prompt: current.prompt, answer: current.answer },
    answer,
    { includeSpeedBonus: false },
  );

  session.score += evaluation.earned;
  await recordScore(session.deckId, userId, evaluation.earned, current.id);
  session.cursor += 1;
  const hasNext = session.cursor < session.cards.length;

  return {
    evaluation,
    hasNext,
    nextCard: hasNext ? session.cards[session.cursor] : null,
    finished: !hasNext,
    score: session.score,
    card: current,
  };
}

export function endSession(userId) {
  const session = getActiveSession(userId);
  stopSession(userId);
  return session;
}

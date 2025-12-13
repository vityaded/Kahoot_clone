import { evaluateAnswer } from '../evaluation.js';
import { claimCards, recordScore, suspendCardForUser, updateCardProgress, updateSessionPointer } from './storage.js';

const activeSessions = new Map();

export function getActiveSession(userId) {
  return activeSessions.get(userId) || null;
}

function stopSession(userId) {
  activeSessions.delete(userId);
}

export async function startSession(deck, userId, { limit = 10 } = {}) {
  const { cards, session: storedSession } = await claimCards(deck.id, userId, limit);
  if (!cards.length) return null;

  const sessionState = storedSession || {};
  const initialCursor = Number.isFinite(sessionState.cursor) ? Math.max(0, sessionState.cursor) : 0;
  const cursor = Math.min(initialCursor, cards.length);

  if (cards.length && cursor >= cards.length) {
    await updateSessionPointer(userId, deck.id, cards.length, null);
    return null;
  }

  const session = {
    deckId: deck.id,
    userId,
    cards,
    cursor,
    score: sessionState.score || 0,
    startedAt: Date.now(),
    currentCardId: sessionState.currentCardId || null,
    isAwaitingAnswer: Boolean(sessionState.currentCardId),
  };

  if (session.currentCardId) {
    const currentIndex = session.cards.findIndex((card) => card.id === session.currentCardId);
    session.cursor = currentIndex >= 0 ? currentIndex : session.cursor;
  }

  activeSessions.set(userId, session);
  return session;
}

export async function flagBadCard(userId, cardId) {
  const session = getActiveSession(userId);
  if (!session) return null;
  return suspendCardForUser(session.deckId, cardId, userId);
}

export async function submitAnswer(userId, answer) {
  const session = getActiveSession(userId);
  if (!session || !session.isAwaitingAnswer || !session.currentCardId) {
    return { wait: true };
  }

  const current = session.cards[session.cursor];
  if (!current || current.id !== session.currentCardId) {
    return { wait: true };
  }

  session.isAwaitingAnswer = false;
  session.currentCardId = null;

  const evaluation = await evaluateAnswer(
    { prompt: current.prompt, answer: current.answer },
    answer,
    { includeSpeedBonus: false },
  );

  await updateCardProgress(session.deckId, userId, current.id, evaluation);
  session.score += evaluation.earned;
  await recordScore(session.deckId, userId, evaluation.earned, current.id);
  session.cursor += 1;
  await updateSessionPointer(userId, session.deckId, session.cursor, null);
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

export async function endSession(userId) {
  const session = getActiveSession(userId);
  if (session) {
    await updateSessionPointer(userId, session.deckId, session.cursor, null);
  }
  stopSession(userId);
  return session;
}

export async function markCardActive(userId, cardId) {
  const session = getActiveSession(userId);
  if (!session || !cardId) {
    if (session) {
      session.currentCardId = null;
      session.isAwaitingAnswer = false;
      await updateSessionPointer(userId, session.deckId, session.cursor, null);
    }
    return null;
  }

  const index = session.cards.findIndex((card) => card.id === cardId);
  if (index >= 0) {
    session.cursor = index;
  }

  session.currentCardId = cardId;
  session.isAwaitingAnswer = true;
  await updateSessionPointer(userId, session.deckId, session.cursor, session.currentCardId);
  return session.currentCardId;
}

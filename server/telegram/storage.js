import fs from 'fs/promises';
import path from 'path';
import { customAlphabet } from 'nanoid';

const DATA_DIR = path.join(process.cwd(), 'data', 'telegram');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const generateToken = customAlphabet('123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 12);

const state = {
  decks: {},
  students: {},
  progress: {},
};

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state.decks = parsed.decks || {};
    state.students = parsed.students || {};
    state.progress = parsed.progress || {};
  } catch (error) {
    if (error.code !== 'ENOENT') {
      /* eslint-disable no-console */
      console.error('Failed to read Telegram state', error);
    }
  }
}

async function persistState() {
  await ensureDataDir();
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(STATE_FILE, payload, 'utf8');
}

export function createDeck({ title, cards = [], media = [], mediaDir }) {
  const id = generateToken();
  const joinToken = generateToken();
  const deck = {
    id,
    title: title || 'Imported deck',
    cards,
    media,
    mediaDir,
    joinToken,
    newPerDay: 20,
    disabled: false,
    badCards: [],
    createdAt: Date.now(),
    stats: {},
  };

  state.decks[id] = deck;
  persistState().catch(() => {});
  return deck;
}

export function rotateDeckToken(deckId) {
  const deck = state.decks[deckId];
  if (!deck) return null;
  deck.joinToken = generateToken();
  persistState().catch(() => {});
  return deck.joinToken;
}

export function disableDeck(deckId) {
  const deck = state.decks[deckId];
  if (!deck) return null;
  deck.disabled = true;
  persistState().catch(() => {});
  return true;
}

export function setNewPerDay(deckId, amount) {
  const deck = state.decks[deckId];
  if (!deck) return null;
  deck.newPerDay = Number(amount) || deck.newPerDay;
  persistState().catch(() => {});
  return deck.newPerDay;
}

export function recordBadCard(deckId, cardId) {
  const deck = state.decks[deckId];
  if (!deck) return null;
  if (!deck.badCards.includes(cardId)) {
    deck.badCards.push(cardId);
    persistState().catch(() => {});
  }
  return deck.badCards;
}

export function getDeckByToken(token) {
  const deck = Object.values(state.decks).find((entry) => entry.joinToken === token);
  return deck || null;
}

export function getDeck(deckId) {
  return state.decks[deckId] || null;
}

export function listDecks() {
  return Object.values(state.decks);
}

function getStudentEntry(userId) {
  if (!state.students[userId]) {
    state.students[userId] = { joined: {}, lastDeck: null };
  }
  return state.students[userId];
}

export function joinDeck(userId, deckId) {
  const deck = getDeck(deckId);
  if (!deck || deck.disabled) return null;
  const student = getStudentEntry(userId);
  student.joined[deckId] = true;
  student.lastDeck = deckId;
  persistState().catch(() => {});
  return deck;
}

export function setLastDeck(userId, deckId) {
  const student = getStudentEntry(userId);
  student.lastDeck = deckId;
  persistState().catch(() => {});
}

export function resolveDeckForUser(userId, deckTokenOrId = null) {
  const deckByToken = deckTokenOrId ? getDeckByToken(deckTokenOrId) : null;
  const deckId = deckByToken?.id || deckTokenOrId;
  if (deckId && state.decks[deckId]) return state.decks[deckId];
  const student = state.students[userId];
  if (student?.lastDeck && state.decks[student.lastDeck]) return state.decks[student.lastDeck];
  const joinedIds = student ? Object.keys(student.joined || {}) : [];
  if (joinedIds.length) return state.decks[joinedIds[0]];
  return null;
}

export function getProgress(deckId, userId) {
  if (!state.progress[deckId]) state.progress[deckId] = {};
  if (!state.progress[deckId][userId]) {
    state.progress[deckId][userId] = {
      lastReset: Date.now(),
      todayNew: 0,
      cursor: 0,
      attempts: 0,
      score: 0,
    };
  }
  return state.progress[deckId][userId];
}

function resetDailyProgress(deckId, userId) {
  const entry = getProgress(deckId, userId);
  entry.lastReset = Date.now();
  entry.todayNew = 0;
  entry.cursor = 0;
  entry.score = 0;
  persistState().catch(() => {});
}

export function claimCards(deckId, userId, limit) {
  const deck = getDeck(deckId);
  if (!deck) return [];
  const progress = getProgress(deckId, userId);

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  if (now - progress.lastReset > dayMs) {
    resetDailyProgress(deckId, userId);
  }

  const available = Math.min(deck.newPerDay - progress.todayNew, limit);
  if (available <= 0) return [];

  const slice = deck.cards.slice(progress.cursor, progress.cursor + available);
  progress.cursor = progress.cursor + available;
  progress.todayNew += slice.length;
  persistState().catch(() => {});
  return slice;
}

export function recordScore(deckId, userId, deltaScore) {
  const progress = getProgress(deckId, userId);
  progress.score += deltaScore;
  progress.attempts += 1;
  const deck = getDeck(deckId);
  if (deck) {
    const key = String(userId);
    if (!deck.stats[key]) deck.stats[key] = { attempts: 0, score: 0 };
    deck.stats[key].attempts += 1;
    deck.stats[key].score += deltaScore;
  }
  persistState().catch(() => {});
  return progress.score;
}

export function exportStats(deckId) {
  const deck = getDeck(deckId);
  if (!deck) return null;
  return {
    id: deck.id,
    title: deck.title,
    stats: deck.stats,
    badCards: deck.badCards,
  };
}

export { persistState };

import { customAlphabet, nanoid } from 'nanoid';
import path from 'path';
import { runMigrations, withClient } from './db.js';

const DEFAULT_LEARNING_STEPS_MINUTES = [1, 10];
const DEFAULT_LEARNING_GRADUATE_DAYS = 3;

function parseLearningSteps(value) {
  if (!value) return DEFAULT_LEARNING_STEPS_MINUTES;
  const parsed = String(value)
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry >= 1);
  return parsed.length ? parsed : DEFAULT_LEARNING_STEPS_MINUTES;
}

function parseGraduateDays(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LEARNING_GRADUATE_DAYS;
  return parsed;
}

export const LEARNING_STEPS_MINUTES = parseLearningSteps(process.env.LEARNING_STEPS_MINUTES);
export const LEARNING_GRADUATE_DAYS = parseGraduateDays(process.env.LEARNING_GRADUATE_DAYS);
const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const EASE_BONUS = 0.05;
const EASE_PENALTY = 0.2;

const generateToken = customAlphabet('123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 12);

function mapDeckRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    joinToken: row.token,
    newPerDay: row.new_per_day,
    disabled: row.disabled,
    mediaDir: row.media_dir,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
  };
}

function mapCardRow(row) {
  if (!row) return null;
  const hasMedia = row.media_type || row.tg_file_id || row.media_src || row.media_name;
  const media = hasMedia
    ? {
        type: row.media_type,
        src: row.media_src,
        name: row.media_name,
        tgFileId: row.tg_file_id,
        sha256: row.media_sha256,
      }
    : null;
  return {
    id: row.id,
    prompt: row.prompt,
    answer: row.answer,
    subtitle: row.subtitle,
    media,
  };
}

function mapProgressRow(row) {
  const hasProgress = row && (row.state || row.ease || row.interval_days || row.learning_step || row.lapses);
  return {
    state: hasProgress ? row.state : 'new',
    ease: Number(hasProgress ? row.ease : DEFAULT_EASE) || DEFAULT_EASE,
    intervalDays: Number(hasProgress ? row.interval_days : 0) || 0,
    learningStep: Number(hasProgress ? row.learning_step : 0) || 0,
    lapses: Number(hasProgress ? row.lapses : 0) || 0,
    dueAt: row?.due_at ? new Date(row.due_at).getTime() : null,
  };
}

function mapCardWithProgress(row) {
  const card = mapCardRow(row);
  return { ...card, progress: mapProgressRow(row) };
}

function mapSessionRow(row) {
  return {
    id: row?.id || null,
    cardQueue: Array.isArray(row?.card_queue)
      ? row.card_queue
      : row?.card_queue
        ? JSON.parse(row.card_queue)
        : [],
    cursor: Number(row?.cursor) || 0,
    todayNew: Number(row?.today_new) || 0,
    attempts: Number(row?.attempts) || 0,
    score: Number(row?.score) || 0,
    currentCardId: row?.current_card_id || null,
    studyDate: row?.study_date || null,
  };
}

export async function loadState() {
  await runMigrations();
}

export async function createDeck({ title, cards = [], media = [], mediaDir, uploadMedia = null }) {
  const deckId = generateToken();
  const joinToken = generateToken();
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO decks (id, title, token, new_per_day, disabled, media_dir)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [deckId, title || 'Imported deck', joinToken, 20, false, mediaDir || null],
    );

    const uploadedByHash = new Map();

    const cardInserts = cards.map(async (card, index) => {
      const id = nanoid();
      const mediaEntry = card.media || media.find((entry) => path.basename(entry.name) === card.media?.name);
      let uploadResult = null;

      if (mediaEntry && uploadMedia) {
        const cacheKey = mediaEntry.sha256 || mediaEntry.src || mediaEntry.name;
        if (uploadedByHash.has(cacheKey)) {
          uploadResult = uploadedByHash.get(cacheKey);
        } else {
          uploadResult = await uploadMedia(mediaEntry);
          uploadedByHash.set(cacheKey, uploadResult);
        }
      }

      return client.query(
        `INSERT INTO cards
          (id, deck_id, note_guid, prompt, answer, subtitle, media_type, media_src, media_name, position, tg_file_id, media_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (deck_id, note_guid) DO NOTHING`,
        [
          id,
          deckId,
          String(card.id),
          card.prompt || '',
          card.answer || '',
          card.subtitle || '',
          mediaEntry?.type || null,
          mediaEntry?.src || null,
          mediaEntry?.name || null,
          index,
          uploadResult?.fileId || mediaEntry?.tgFileId || null,
          uploadResult?.sha256 || mediaEntry?.sha256 || null,
        ],
      );
    });

    await Promise.all(cardInserts);
  });

  return getDeck(deckId);
}

export async function rotateDeckToken(deckId) {
  const newToken = generateToken();
  const { rowCount } = await withClient((client) =>
    client.query('UPDATE decks SET token = $1 WHERE id = $2', [newToken, deckId]),
  );
  return rowCount ? newToken : null;
}

export async function disableDeck(deckId) {
  const { rowCount } = await withClient((client) =>
    client.query('UPDATE decks SET disabled = TRUE WHERE id = $1', [deckId]),
  );
  return Boolean(rowCount);
}

export async function setNewPerDay(deckId, amount) {
  const { rows } = await withClient((client) =>
    client.query('UPDATE decks SET new_per_day = $1 WHERE id = $2 RETURNING new_per_day', [amount, deckId]),
  );
  return rows[0]?.new_per_day || null;
}

export async function recordBadCard(deckId, cardId, flaggedBy = null) {
  await withClient((client) =>
    client.query(
      `INSERT INTO flags (deck_id, card_id, flagged_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (deck_id, card_id, flagged_by) DO NOTHING`,
      [deckId, cardId, flaggedBy],
    ),
  );

  const { rows } = await withClient((client) =>
    client.query('SELECT DISTINCT card_id FROM flags WHERE deck_id = $1 ORDER BY card_id', [deckId]),
  );
  return rows.map((row) => row.card_id);
}

export async function getDeckByToken(token) {
  const { rows } = await withClient((client) =>
    client.query('SELECT * FROM decks WHERE token = $1 LIMIT 1', [token]),
  );
  return mapDeckRow(rows[0]);
}

export async function getDeck(deckId) {
  const { rows } = await withClient((client) =>
    client.query('SELECT * FROM decks WHERE id = $1 LIMIT 1', [deckId]),
  );
  return mapDeckRow(rows[0]);
}

export async function listDecks() {
  const { rows } = await withClient((client) => client.query('SELECT * FROM decks ORDER BY created_at DESC'));
  return rows.map(mapDeckRow);
}

export async function joinDeck(userId, deckId) {
  const deck = await getDeck(deckId);
  if (!deck || deck.disabled) return null;

  await withClient((client) =>
    client.query(
      `INSERT INTO enrollments (user_id, deck_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, deck_id) DO NOTHING`,
      [String(userId), deckId],
    ),
  );
  await setLastDeck(userId, deckId);
  return deck;
}

export async function setLastDeck(userId, deckId) {
  await withClient((client) =>
    client.query(
      `INSERT INTO user_preferences (user_id, last_deck_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET last_deck_id = EXCLUDED.last_deck_id`,
      [String(userId), deckId],
    ),
  );
}

async function getLastDeck(userId) {
  const { rows } = await withClient((client) =>
    client.query('SELECT last_deck_id FROM user_preferences WHERE user_id = $1 LIMIT 1', [String(userId)]),
  );
  return rows[0]?.last_deck_id || null;
}

export async function resolveDeckForUser(userId, deckTokenOrId = null) {
  const deckByToken = deckTokenOrId ? await getDeckByToken(deckTokenOrId) : null;
  const preferredId = deckByToken?.id || deckTokenOrId;
  if (preferredId) {
    const direct = await getDeck(preferredId);
    if (direct) return direct;
  }

  const lastDeckId = await getLastDeck(userId);
  if (lastDeckId) {
    const fromPrefs = await getDeck(lastDeckId);
    if (fromPrefs) return fromPrefs;
  }

  const { rows } = await withClient((client) =>
    client.query('SELECT deck_id FROM enrollments WHERE user_id = $1 ORDER BY joined_at ASC LIMIT 1', [
      String(userId),
    ]),
  );
  if (rows[0]?.deck_id) {
    return getDeck(rows[0].deck_id);
  }

  return null;
}

async function getDeckSession(userId, deckId, today) {
  const { rows } = await withClient((client) =>
    client.query(
      `INSERT INTO study_sessions (user_id, deck_id, study_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, deck_id, study_date)
       DO UPDATE SET study_date = EXCLUDED.study_date
       RETURNING *`,
      [String(userId), deckId, today],
    ),
  );
  return mapSessionRow(rows[0]);
}

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function ensureProgress(userId, cardIds = []) {
  if (!cardIds.length) return;
  await withClient((client) =>
    Promise.all(
      cardIds.map((cardId) =>
        client.query(
          `INSERT INTO card_progress (user_id, card_id, state, due_at)
           VALUES ($1, $2, 'new', NOW())
           ON CONFLICT (user_id, card_id) DO NOTHING`,
          [String(userId), cardId],
        ),
      ),
    ),
  );
}

async function getCardsByIds(cardIds = [], userId) {
  if (!cardIds.length) return [];

  const { rows } = await withClient((client) =>
    client.query(
      `SELECT c.id, c.prompt, c.answer, c.subtitle, c.media_type, c.media_src, c.media_name,
              c.tg_file_id, c.media_sha256,
              cp.state, cp.ease, cp.interval_days, cp.learning_step, cp.lapses, cp.due_at
       FROM cards c
       LEFT JOIN card_progress cp ON cp.card_id = c.id AND cp.user_id = $2
       WHERE c.id = ANY($1)
       ORDER BY array_position($1::text[], c.id)`,
      [cardIds, String(userId)],
    ),
  );

  return rows.map(mapCardWithProgress);
}

export async function claimCards(deckId, userId, limit) {
  const deck = await getDeck(deckId);
  if (!deck || deck.disabled) return { cards: [], session: null };

  const today = new Date().toISOString().slice(0, 10);
  const session = await getDeckSession(userId, deckId, today);

  if (session.cardQueue.length) {
    const cards = await getCardsByIds(session.cardQueue, userId);
    return { cards, session };
  }

  const now = new Date();
  const { rows: dueRows } = await withClient((client) =>
    client.query(
      `SELECT c.id, c.prompt, c.answer, c.subtitle, c.media_type, c.media_src, c.media_name,
              c.tg_file_id, c.media_sha256,
              cp.state, cp.ease, cp.interval_days, cp.learning_step, cp.lapses, cp.due_at
       FROM card_progress cp
       JOIN cards c ON c.id = cp.card_id
       WHERE cp.user_id = $1
         AND c.deck_id = $2
         AND cp.state IN ('learning', 'review')
         AND (cp.due_at IS NULL OR cp.due_at <= $3)
       ORDER BY cp.due_at ASC NULLS FIRST
       LIMIT $4`,
      [String(userId), deckId, now, limit],
    ),
  );

  const dueCards = dueRows.map(mapCardWithProgress);
  let remaining = limit - dueCards.length;
  if (remaining <= 0) return { cards: dueCards, session };

  const newAvailable = Math.min(deck.newPerDay - session.todayNew, remaining);
  if (newAvailable <= 0) return { cards: dueCards, session };

  const { rows: newRows } = await withClient((client) =>
    client.query(
      `SELECT c.id, c.prompt, c.answer, c.subtitle, c.media_type, c.media_src, c.media_name,
              c.tg_file_id, c.media_sha256,
              cp.state, cp.ease, cp.interval_days, cp.learning_step, cp.lapses, cp.due_at
       FROM cards c
       LEFT JOIN card_progress cp ON cp.card_id = c.id AND cp.user_id = $2
       WHERE c.deck_id = $1
         AND COALESCE(cp.state, 'new') = 'new'
         AND COALESCE(cp.state <> 'suspended', TRUE)
       ORDER BY c.position ASC
       LIMIT $3`,
      [deckId, String(userId), newAvailable],
    ),
  );

  const newCardIds = newRows.map((row) => row.id);
  await ensureProgress(userId, newCardIds);

  if (newCardIds.length) {
    await withClient((client) =>
      client.query(
        `UPDATE study_sessions
         SET today_new = today_new + $1
         WHERE user_id = $2 AND deck_id = $3 AND study_date = $4`,
        [newCardIds.length, String(userId), deckId, today],
      ),
    );
  }

  const newCards = newRows.map(mapCardWithProgress);
  const queue = [...dueCards, ...newCards].slice(0, limit);
  const queueIds = queue.map((card) => card.id);

  await withClient((client) =>
    client.query(
      `UPDATE study_sessions
       SET card_queue = $1, cursor = 0, current_card_id = NULL
       WHERE user_id = $2 AND deck_id = $3 AND study_date = $4`,
      [queueIds, String(userId), deckId, today],
    ),
  );

  const updatedSession = { ...session, cardQueue: queueIds, todayNew: session.todayNew + newCardIds.length };
  return { cards: queue, session: updatedSession };
}

export async function updateSessionPointer(userId, deckId, cursor, currentCardId = null) {
  const today = new Date().toISOString().slice(0, 10);
  await getDeckSession(userId, deckId, today);

  await withClient((client) =>
    client.query(
      `UPDATE study_sessions
       SET cursor = $1, current_card_id = $2
       WHERE user_id = $3 AND deck_id = $4 AND study_date = $5`,
      [cursor, currentCardId, String(userId), deckId, today],
    ),
  );
}

export async function recordScore(deckId, userId, deltaScore, cardId) {
  const today = new Date().toISOString().slice(0, 10);
  await getDeckSession(userId, deckId, today);

  await withClient((client) =>
    client.query(
      `UPDATE study_sessions
       SET attempts = attempts + 1, score = score + $1
       WHERE user_id = $2 AND deck_id = $3 AND study_date = $4`,
      [deltaScore, String(userId), deckId, today],
    ),
  );

  if (cardId) {
    await withClient((client) =>
      client.query(
        `INSERT INTO reviews (user_id, card_id, attempts, score)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (user_id, card_id)
         DO UPDATE SET attempts = reviews.attempts + 1, score = reviews.score + EXCLUDED.score, last_reviewed = NOW()`,
        [String(userId), cardId, deltaScore],
      ),
    );
  }
}

export async function updateCardProgress(deckId, userId, cardId, evaluation) {
  const userKey = String(userId);
  const isPassing = evaluation.isCorrect || evaluation.isPartial;
  return withClient(async (client) => {
    const { rows: existingRows } = await client.query(
      `INSERT INTO card_progress (user_id, card_id, state, due_at)
       VALUES ($1, $2, 'new', NOW())
       ON CONFLICT (user_id, card_id) DO UPDATE SET state = card_progress.state
       RETURNING *`,
      [userKey, cardId],
    );

    const progress = mapProgressRow(existingRows[0]);
    if (progress.state === 'suspended') return progress;

    let nextState = progress.state || 'new';
    let nextEase = progress.ease || DEFAULT_EASE;
    let nextInterval = progress.intervalDays || 0;
    let nextLearningStep = progress.learningStep || 0;
    let nextLapses = progress.lapses || 0;
    let nextDue = new Date();

    if (progress.state === 'review') {
      if (isPassing) {
        nextEase = Math.max(MIN_EASE, progress.ease + EASE_BONUS);
        const baseInterval = progress.intervalDays || LEARNING_GRADUATE_DAYS;
        nextInterval = Math.max(LEARNING_GRADUATE_DAYS, Math.round(baseInterval * nextEase));
        nextDue = daysFromNow(nextInterval);
        nextLearningStep = 0;
        nextState = 'review';
      } else {
        nextEase = Math.max(MIN_EASE, progress.ease - EASE_PENALTY);
        nextLapses += 1;
        nextInterval = 0;
        nextLearningStep = 0;
        nextDue = minutesFromNow(LEARNING_STEPS_MINUTES[0]);
        nextState = 'learning';
      }
    } else {
      const nextStep = progress.learningStep + (isPassing ? 1 : 0);
      if (isPassing && nextStep >= LEARNING_STEPS_MINUTES.length) {
        nextState = 'review';
        nextInterval = LEARNING_GRADUATE_DAYS;
        nextDue = daysFromNow(nextInterval);
        nextLearningStep = 0;
      } else {
        nextState = 'learning';
        nextLearningStep = isPassing ? nextStep : 0;
        const stepIndex = Math.min(nextLearningStep, LEARNING_STEPS_MINUTES.length - 1);
        nextDue = minutesFromNow(LEARNING_STEPS_MINUTES[stepIndex]);
      }
    }

    const { rows: updated } = await client.query(
      `UPDATE card_progress
       SET state = $3,
           ease = $4,
           interval_days = $5,
           learning_step = $6,
           lapses = $7,
           due_at = $8
       WHERE user_id = $1 AND card_id = $2
       RETURNING *`,
      [userKey, cardId, nextState, nextEase, nextInterval, nextLearningStep, nextLapses, nextDue],
    );

    if (evaluation?.isCorrect && cardId) {
      await client.query('UPDATE reviews SET last_reviewed = NOW() WHERE user_id = $1 AND card_id = $2', [
        userKey,
        cardId,
      ]);
    }

    return mapProgressRow(updated[0]);
  });
}

export async function suspendCardForUser(deckId, cardId, userId) {
  const userKey = String(userId);
  await ensureProgress(userId, [cardId]);
  const { rows } = await withClient((client) =>
    client.query(
      `UPDATE card_progress
       SET state = 'suspended', interval_days = 0, learning_step = 0, lapses = lapses, due_at = NULL
       WHERE user_id = $1 AND card_id = $2
       RETURNING *`,
      [userKey, cardId],
    ),
  );
  await recordBadCard(deckId, cardId, userId);
  return mapProgressRow(rows[0]);
}

export async function exportStats(deckId) {
  const deck = await getDeck(deckId);
  if (!deck) return null;

  const { rows } = await withClient((client) =>
    client.query(
      `SELECT r.user_id, SUM(r.attempts) AS attempts, SUM(r.score) AS score
       FROM reviews r
       JOIN cards c ON c.id = r.card_id
       WHERE c.deck_id = $1
       GROUP BY r.user_id`,
      [deckId],
    ),
  );

  const stats = rows.reduce((acc, row) => {
    acc[row.user_id] = { attempts: Number(row.attempts) || 0, score: Number(row.score) || 0 };
    return acc;
  }, {});

  const { rows: flaggedRows } = await withClient((client) =>
    client.query('SELECT DISTINCT card_id FROM flags WHERE deck_id = $1 ORDER BY card_id', [deckId]),
  );

  return { id: deck.id, title: deck.title, stats, badCards: flaggedRows.map((row) => row.card_id) };
}

export { loadState as persistState };

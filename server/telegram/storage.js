import { customAlphabet, nanoid } from 'nanoid';
import path from 'path';
import { runMigrations, withClient } from './db.js';

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
  const media = row.media_type
    ? { type: row.media_type, src: row.media_src, name: row.media_name }
    : null;
  return {
    id: row.id,
    prompt: row.prompt,
    answer: row.answer,
    subtitle: row.subtitle,
    media,
  };
}

export async function loadState() {
  await runMigrations();
}

export async function createDeck({ title, cards = [], media = [], mediaDir }) {
  const deckId = generateToken();
  const joinToken = generateToken();
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO decks (id, title, token, new_per_day, disabled, media_dir)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [deckId, title || 'Imported deck', joinToken, 20, false, mediaDir || null],
    );

    const cardInserts = cards.map((card, index) => {
      const id = nanoid();
      const mediaEntry = card.media || media.find((entry) => path.basename(entry.name) === card.media?.name);
      return client.query(
        `INSERT INTO cards
          (id, deck_id, note_guid, prompt, answer, subtitle, media_type, media_src, media_name, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
  return rows[0];
}

export async function claimCards(deckId, userId, limit) {
  const deck = await getDeck(deckId);
  if (!deck || deck.disabled) return [];

  const today = new Date().toISOString().slice(0, 10);
  const session = await getDeckSession(userId, deckId, today);
  const available = Math.min(deck.newPerDay - session.today_new, limit);
  if (available <= 0) return [];

  const { rows: cards } = await withClient((client) =>
    client.query(
      `SELECT id, prompt, answer, subtitle, media_type, media_src, media_name
       FROM cards
       WHERE deck_id = $1
       ORDER BY position ASC
       OFFSET $2 LIMIT $3`,
      [deckId, session.cursor, available],
    ),
  );

  const claimed = cards.map(mapCardRow);
  await withClient((client) =>
    client.query(
      `UPDATE study_sessions
       SET cursor = cursor + $1, today_new = today_new + $1
       WHERE user_id = $2 AND deck_id = $3 AND study_date = $4`,
      [claimed.length, String(userId), deckId, today],
    ),
  );

  return claimed;
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

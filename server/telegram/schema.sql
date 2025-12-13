CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  new_per_day INTEGER NOT NULL DEFAULT 20,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  media_dir TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  note_guid TEXT NOT NULL,
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL,
  subtitle TEXT,
  media_type TEXT,
  media_src TEXT,
  media_name TEXT,
  position INTEGER NOT NULL,
  UNIQUE (deck_id, note_guid)
);

CREATE TABLE IF NOT EXISTS enrollments (
  user_id TEXT NOT NULL,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, deck_id)
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  last_deck_id TEXT REFERENCES decks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS study_sessions (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  study_date DATE NOT NULL,
  today_new INTEGER NOT NULL DEFAULT 0,
  card_queue JSONB NOT NULL DEFAULT '[]'::jsonb,
  cursor INTEGER NOT NULL DEFAULT 0,
  current_card_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, deck_id, study_date)
);

ALTER TABLE study_sessions
  ADD COLUMN IF NOT EXISTS card_queue JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS current_card_id TEXT;

CREATE TABLE IF NOT EXISTS reviews (
  user_id TEXT NOT NULL,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  last_reviewed TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE IF NOT EXISTS card_progress (
  user_id TEXT NOT NULL,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'new',
  ease NUMERIC NOT NULL DEFAULT 2.5,
  interval_days INTEGER NOT NULL DEFAULT 0,
  learning_step INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  due_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE IF NOT EXISTS flags (
  id SERIAL PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  flagged_by TEXT,
  flagged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deck_id, card_id, flagged_by)
);

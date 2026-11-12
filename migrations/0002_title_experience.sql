-- Add durable personalization, discovery feedback, and community review storage.
CREATE TABLE IF NOT EXISTS title_user_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('view','watch','complete','skip','save')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_title_events_user_time ON title_user_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_title_events_title_type ON title_user_events(title_id, event_type);
CREATE TABLE IF NOT EXISTS user_title_preferences (
  user_id TEXT PRIMARY KEY,
  languages_json TEXT NOT NULL DEFAULT '[]',
  genres_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS title_reviews (
  id TEXT PRIMARY KEY,
  title_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published','hidden')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(title_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_title_reviews_title_status ON title_reviews(title_id,status,created_at DESC);

-- MaseTv Cloudflare migration: additive schema only.
-- This file is for review/testing on the migration branch. Do NOT run against
-- production until the application migration and rollback plan are verified.
-- Existing admins, sessions, and catalog tables are intentionally untouched.

CREATE TABLE IF NOT EXISTS masetv_titles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('Movie', 'Drama')),
  year TEXT NOT NULL DEFAULT '',
  quality TEXT NOT NULL DEFAULT '720p',
  poster_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  featured INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_masetv_titles_type_created
  ON masetv_titles(type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_masetv_titles_name
  ON masetv_titles(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS masetv_broadcasts (
  id TEXT PRIMARY KEY,
  destination TEXT NOT NULL DEFAULT 'website'
    CHECK (destination IN ('website', 'telegram', 'both')),
  expires_at TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_masetv_broadcasts_created
  ON masetv_broadcasts(created_at DESC);

CREATE TABLE IF NOT EXISTS masetv_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS masetv_ai_reports (
  id TEXT PRIMARY KEY,
  query_text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'website',
  count INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_masetv_ai_reports_count
  ON masetv_ai_reports(count DESC, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS masetv_telegram_subscriptions (
  chat_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS masetv_telegram_state (
  state_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

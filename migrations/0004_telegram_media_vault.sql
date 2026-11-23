-- Telegram-backed MaseNet media vault. Metadata only: the video bytes remain in Telegram.
CREATE TABLE IF NOT EXISTS telegram_media_assets (
  id TEXT PRIMARY KEY,
  title_id TEXT,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('movie','drama')),
  title TEXT NOT NULL,
  release_year INTEGER,
  season INTEGER NOT NULL DEFAULT 0,
  episode INTEGER NOT NULL DEFAULT 0,
  episode_title TEXT,
  quality TEXT NOT NULL DEFAULT 'Unknown',
  codec TEXT NOT NULL DEFAULT 'Unknown',
  container_format TEXT NOT NULL DEFAULT 'Unknown',
  language TEXT NOT NULL DEFAULT 'Unknown',
  file_name TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  vault_chat_id TEXT NOT NULL,
  vault_message_id INTEGER NOT NULL,
  file_unique_id TEXT,
  source_update_id INTEGER UNIQUE,
  source_bot TEXT NOT NULL DEFAULT 'MaseNetStreamManagerBot',
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','published','disabled','missing')),
  rights_confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(vault_chat_id, vault_message_id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_media_title_episode
  ON telegram_media_assets(title_id, media_kind, season, episode, quality);
CREATE INDEX IF NOT EXISTS idx_telegram_media_title_status
  ON telegram_media_assets(title, status);
CREATE TABLE IF NOT EXISTS telegram_media_delivery_tokens (
  token_hash TEXT PRIMARY KEY,
  media_asset_id TEXT NOT NULL REFERENCES telegram_media_assets(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_telegram_media_delivery_expiry
  ON telegram_media_delivery_tokens(expires_at);

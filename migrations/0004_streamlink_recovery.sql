-- Additive recovery audit only. Existing title and episode records are not modified by this migration.
CREATE TABLE IF NOT EXISTS streamlink_recovery_history (
  id TEXT PRIMARY KEY,
  title_id TEXT NOT NULL,
  episode_id TEXT NOT NULL DEFAULT '',
  season INTEGER NOT NULL DEFAULT 0,
  episode INTEGER NOT NULL DEFAULT 0,
  quality TEXT NOT NULL DEFAULT 'Unknown',
  codec TEXT NOT NULL DEFAULT 'Unknown',
  old_url TEXT NOT NULL,
  new_url TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'telegram-user-session',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_streamlink_recovery_title_time
  ON streamlink_recovery_history(title_id, created_at DESC);

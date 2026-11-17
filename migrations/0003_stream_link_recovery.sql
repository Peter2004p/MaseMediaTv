CREATE TABLE IF NOT EXISTS stream_link_recovery_log (
  id TEXT PRIMARY KEY,
  title_id TEXT NOT NULL,
  title_name TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  old_url TEXT NOT NULL,
  new_url TEXT NOT NULL,
  verification_status INTEGER NOT NULL,
  admin_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stream_link_recovery_title_created
  ON stream_link_recovery_log(title_id, created_at DESC);

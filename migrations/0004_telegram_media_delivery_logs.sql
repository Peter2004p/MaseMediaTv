-- Delivery audit trail. Store Telegram user identifiers only as needed for abuse investigation.
CREATE TABLE IF NOT EXISTS telegram_media_delivery_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_asset_id TEXT NOT NULL REFERENCES telegram_media_assets(id),
  chat_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_telegram_media_delivery_asset
  ON telegram_media_delivery_logs(media_asset_id, delivered_at);

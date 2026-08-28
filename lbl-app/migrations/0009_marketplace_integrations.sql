ALTER TABLE bids ADD COLUMN desired_rank INTEGER;

ALTER TABLE listing_details ADD COLUMN revenue_daily_json TEXT;
ALTER TABLE listing_details ADD COLUMN google_analytics_json TEXT;
ALTER TABLE listing_details ADD COLUMN google_search_console_json TEXT;

ALTER TABLE deals ADD COLUMN buyer_visible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE deals ADD COLUMN cancelled_at TEXT;

CREATE TABLE IF NOT EXISTS google_connections (
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('analytics', 'search_console')),
  property_ref TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (listing_id, provider)
);

CREATE TABLE IF NOT EXISTS message_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_message_media_message ON message_media(message_id);

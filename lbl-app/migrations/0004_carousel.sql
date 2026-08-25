CREATE TABLE IF NOT EXISTS carousel_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reservation_id TEXT NOT NULL UNIQUE,
  checkout_session_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'paid', 'expired', 'refunded')),
  reserved_until TEXT NOT NULL,
  starts_at TEXT,
  expires_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_carousel_orders_slot_active ON carousel_orders(slot_id, status, expires_at);

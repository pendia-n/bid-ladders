CREATE TABLE IF NOT EXISTS rank_reservations (
  desired_rank INTEGER PRIMARY KEY CHECK (desired_rank BETWEEN 1 AND 330),
  bid_id INTEGER NOT NULL UNIQUE REFERENCES bids(id) ON DELETE CASCADE,
  reserved_until TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rank_reservations_expiry
  ON rank_reservations(reserved_until);

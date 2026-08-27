ALTER TABLE users ADD COLUMN contact_email TEXT;
ALTER TABLE deals ADD COLUMN escrow_provider TEXT;
ALTER TABLE deals ADD COLUMN escrow_transaction_id TEXT;
ALTER TABLE deals ADD COLUMN escrow_status TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE deals ADD COLUMN escrow_url TEXT;
ALTER TABLE deals ADD COLUMN escrow_updated_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deals_escrow_transaction
  ON deals(escrow_transaction_id)
  WHERE escrow_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS listing_details (
  listing_id INTEGER PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  category TEXT,
  problem_solved TEXT,
  audience TEXT,
  pricing_model TEXT,
  tech_stack TEXT,
  total_revenue_cents INTEGER,
  last_30d_revenue_cents INTEGER,
  active_customers INTEGER,
  growth_percent REAL,
  churn_percent REAL,
  github_url TEXT,
  google_analytics_property TEXT,
  google_search_console_url TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_listing_details_category ON listing_details(category);

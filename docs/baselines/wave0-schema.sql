-- Money Tracker Wave 0 schema baseline
-- Baseline source commit: aafd33227f4f3411781bb17be1bd920274884ea2
-- Captured before the exact-money migration. Wave 1 must migrate these REAL money columns deliberately.
-- SQLite PRAGMAs at runtime: foreign_keys=ON, journal_mode=WAL, busy_timeout=5000.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT 'My Ledger',
  password_hash TEXT NOT NULL,
  default_currency TEXT NOT NULL DEFAULT 'USD',
  is_owner INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE people (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id,id)
);
CREATE TABLE accounts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  currency TEXT NOT NULL,
  opening_balance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id,id)
);
CREATE TABLE entries (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  person_id TEXT,
  account_id TEXT,
  from_account_id TEXT,
  to_account_id TEXT,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT,
  from_amount REAL,
  to_amount REAL,
  signed_amount REAL,
  date TEXT NOT NULL,
  merchant TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  split_json TEXT NOT NULL DEFAULT '[]',
  category_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,id),
  FOREIGN KEY (user_id,person_id) REFERENCES people(user_id,id),
  FOREIGN KEY (user_id,account_id) REFERENCES accounts(user_id,id),
  FOREIGN KEY (user_id,from_account_id) REFERENCES accounts(user_id,id),
  FOREIGN KEY (user_id,to_account_id) REFERENCES accounts(user_id,id)
);
CREATE TABLE attachments (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id,id)
);
CREATE TABLE recurring_rules (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  frequency TEXT NOT NULL,
  interval_value INTEGER NOT NULL DEFAULT 1,
  anchor_date TEXT NOT NULL,
  next_due_date TEXT,
  end_date TEXT,
  remind_days_before INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  template_json TEXT NOT NULL,
  last_posted_at TEXT,
  last_occurrence_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,id)
);
CREATE TABLE categories (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,id)
);
CREATE TABLE budgets (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  monthly_limit REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,id),
  UNIQUE (user_id,category_id,currency)
);
CREATE TABLE bank_feed_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  source_name TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL DEFAULT '',
  txn_date TEXT NOT NULL,
  description TEXT NOT NULL,
  merchant TEXT NOT NULL DEFAULT '',
  signed_amount REAL NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  suggested_type TEXT NOT NULL DEFAULT '',
  suggested_person_id TEXT,
  suggested_target_account_id TEXT,
  suggested_category_id TEXT,
  posted_entry_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,id),
  UNIQUE (user_id,fingerprint)
);
CREATE TABLE bank_rules (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  match_text TEXT NOT NULL,
  classification TEXT NOT NULL,
  person_id TEXT,
  target_account_id TEXT,
  category_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,id)
);

-- Current money-bearing REAL columns that Wave 1 must migrate:
-- accounts.opening_balance
-- entries.amount / entries.from_amount / entries.to_amount / entries.signed_amount
-- budgets.monthly_limit
-- bank_feed_items.signed_amount
-- split allocation amounts are currently numeric values inside entries.split_json.

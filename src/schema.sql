-- ADMIN
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- CUSTOMERS
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  room_identifier TEXT,
  device_name TEXT,
  mac_address TEXT UNIQUE,
  account_status TEXT NOT NULL DEFAULT 'ACTIVE'
      CHECK (account_status IN ('ACTIVE','DISABLED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- PACKAGES
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  duration_hours REAL NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- SUBSCRIPTIONS (access-state table; expiry_time may be mutated on renewal)
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
  package_name_snapshot TEXT NOT NULL,
  price_snapshot INTEGER NOT NULL,
  duration_hours_snapshot REAL NOT NULL,
  start_time TEXT NOT NULL,
  expiry_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
      CHECK (status IN ('ACTIVE','EXPIRED','CANCELLED','SUSPENDED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- PAYMENTS (insert-only financial ledger; subscription_id filled in once processed)
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
  subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'AIRTEL_MONEY'
      CHECK (payment_method IN ('AIRTEL_MONEY','M-PESA')),
  reference_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'VERIFIED'
      CHECK (status IN ('PENDING','VERIFIED','FAILED','REVERSED','REFUNDED')),
  paid_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- EXPENSES
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL,
  category TEXT,
  spent_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- WIFI SUBSCRIBERS (denormalized "hot table" the WhatsApp alert scheduler reads;
-- derived from the ledger by services/subscriberSync.js. customer_id is added
-- by a migration in db.js for databases created before that column existed.)
CREATE TABLE IF NOT EXISTS wifi_subscribers (
  mac_address TEXT PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  start_time TEXT,
  expiry_time TEXT,
  warning_sent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Expired'
      CHECK (status IN ('Active','Expired')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status_expiry ON subscriptions(status, expiry_time);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_wifi_subscribers_customer ON wifi_subscribers(customer_id);
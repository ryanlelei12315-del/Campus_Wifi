const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/campus-wifi.sqlite';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// ---------------------------------------------------------------------------
// Lightweight migrations for databases created before a column existed.
// CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so new columns
// must be added explicitly here. Each step is idempotent and safe to re-run.
// ---------------------------------------------------------------------------
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function addColumnIfMissing(table, column, definition) {
  if (!hasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// wifi_subscribers.customer_id links ledger-derived rows back to the customer
// they were derived from (see services/subscriberSync.js). NULL for hand-added rows.
addColumnIfMissing('wifi_subscribers', 'customer_id', 'INTEGER REFERENCES customers(id) ON DELETE SET NULL');

// Seed the current month's fixed operating expense once.
const monthlyExpense = db.prepare("SELECT id FROM expenses WHERE description = 'Campus WiFi monthly operating expense' AND strftime('%Y-%m', spent_at) = strftime('%Y-%m', 'now') LIMIT 1").get();
if (!monthlyExpense) {
  db.prepare("INSERT INTO expenses (description, amount, category, spent_at) VALUES (?, 1999, 'Operating Costs', datetime('now'))").run('Campus WiFi monthly operating expense');
}

db.exec(
  'CREATE INDEX IF NOT EXISTS idx_wifi_subscribers_customer ON wifi_subscribers(customer_id)'
);

module.exports = db;

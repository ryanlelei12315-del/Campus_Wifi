// One-off backfill: records real M-PESA transactions (customers + payments +
// subscriptions) by replaying them chronologically through the same lifecycle
// the app uses — but backdated to the actual Nairobi times from the SMS messages.
//
// Idempotent: payments whose reference_code already exists are skipped, so the
// script can be re-run safely.
//
// Run: node src/import-mpesa.js
require('dotenv').config();
const db = require('./db');
const { toSqliteUtc } = require('./utils/formatDate');
const { sweepExpired } = require('./services/subscriptionService');

// ---------------------------------------------------------------------------
// Raw transaction data, transcribed from the M-PESA SMS messages.
// Phone numbers are masked in the source messages and stored as-is.
// ---------------------------------------------------------------------------
const TRANSACTIONS = [
  { code: 'UI31O5L139', name: 'Charles Wambeo',    phone: '0701***357', amount: 30,  at: '2026-09-03T15:28:00+03:00' },
  { code: 'UI38G5L8V6', name: 'Nyambane Kwamboka', phone: '0111***156', amount: 30,  at: '2026-09-03T16:07:00+03:00' },
  { code: 'UI3PI51ESB', name: 'Franzen Dixon',     phone: '0718***792', amount: 30,  at: '2026-09-03T18:05:00+03:00' },
  { code: 'UI34V56Z76', name: 'Austin Kagwi',      phone: '0717***460', amount: 30,  at: '2026-09-03T19:44:00+03:00' },
  { code: 'UI51O5U3DD', name: 'Charles Wambeo',    phone: '0701***357', amount: 30,  at: '2026-09-05T16:09:00+03:00' },
  { code: 'UI54V5G9NA', name: 'Austin Kagwi',      phone: '0717***460', amount: 30,  at: '2026-09-05T20:52:00+03:00' },
  { code: 'UI61O5XP1A', name: 'Charles Wambeo',    phone: '0701***357', amount: 30,  at: '2026-09-06T13:07:00+03:00' },
  { code: 'UI71O63NZ3', name: 'Charles Wambeo',    phone: '0701***357', amount: 30,  at: '2026-09-07T19:30:00+03:00' },
  { code: 'UI81O68G0M', name: 'Charles Wambeo',    phone: '0701***357', amount: 30,  at: '2026-09-08T21:20:00+03:00' },
  { code: 'UI94V5TJXZ', name: 'Austin Kagwi',      phone: '0717***460', amount: 30,  at: '2026-09-09T06:16:00+03:00' },
  { code: 'UI98G6BC3Z', name: 'Nyambane Kwamboka', phone: '0111***156', amount: 30,  at: '2026-09-09T14:14:00+03:00' },
  { code: 'UIA1O6HJHU', name: 'Charles Wambeo',    phone: '0701***357', amount: 30,  at: '2026-09-10T22:38:00+03:00' },
  { code: 'UIBPI5YB9W', name: 'Franzen Dixon',     phone: '0718***792', amount: 30,  at: '2026-09-11T10:33:00+03:00' },
  { code: 'UIBK06FFCB', name: 'Veronicah Wafula',  phone: '0712***464', amount: 60,  at: '2026-09-11T13:26:00+03:00' },
  { code: 'UIB1O6K8BN', name: 'Charles Wambeo',    phone: '0701***357', amount: 150, at: '2026-09-11T18:11:00+03:00' },
  { code: 'UIB4V65JAR', name: 'Austin Kagwi',      phone: '0717***460', amount: 30,  at: '2026-09-11T20:26:00+03:00' },
  { code: 'UIBMR65PON', name: 'Brandon Lucas',     phone: '0769***478', amount: 30,  at: '2026-09-11T21:20:00+03:00' },
  { code: 'UIC4V69X5M', name: 'Austin Kagwi',      phone: '0717***460', amount: 30,  at: '2026-09-12T19:40:00+03:00' },
  { code: 'UIDMR6AMPN', name: 'Brandon Lucas',     phone: '0769***478', amount: 30,  at: '2026-09-13T07:47:00+03:00' },
  { code: 'UID8G6TZXP', name: 'Nyambane Kwamboka', phone: '0111***156', amount: 30,  at: '2026-09-13T18:44:00+03:00' },
  { code: 'UIE8G6YYX1', name: 'Nyambane Kwamboka', phone: '0111***156', amount: 30,  at: '2026-09-14T20:34:00+03:00' },
  { code: 'UIEK06UGXI', name: 'Veronicah Wafula',  phone: '0712***464', amount: 30,  at: '2026-09-14T20:37:00+03:00' },
  { code: 'UIEMR6IDEP', name: 'Brandon Lucas',     phone: '0769***478', amount: 30,  at: '2026-09-14T21:04:00+03:00' },
  { code: 'UIEPI6ECB2', name: 'Franzen Dixon',     phone: '0718***792', amount: 30,  at: '2026-09-14T22:09:00+03:00' },
  { code: 'UIFAB6PWPF', name: 'Hosea Mogeni',      phone: '0707***534', amount: 30,  at: '2026-09-15T07:24:00+03:00' },
];

module.exports = { TRANSACTIONS };

// Amount -> package mapping using the seeded catalogue.
// 30 -> "24 Hours" (price 30), 150 -> "7 Days" (price 150).
// Overpayments buy multiple units of the matched package: 60 -> 2 x 24 Hours = 48h.
function pickPackage(amount) {
  const candidates = db
    .prepare('SELECT * FROM packages WHERE is_active = 1 AND price <= ? ORDER BY price DESC')
    .all(amount);
  if (candidates.length === 0) throw new Error(`No package matches amount ${amount}`);
  // Prefer the package whose price exactly divides the amount (largest such).
  const exact = candidates.find((p) => amount % p.price === 0);
  return exact || candidates[candidates.length - 1];
}

// Same semantics as subscriptionService.createOrExtendSubscription, but anchored
// to the historical payment time instead of datetime('now').
function createOrExtendSubscriptionAt(customerId, pkg, units, paidAtUtc) {
  const active = db
    .prepare(
      `SELECT * FROM subscriptions
       WHERE customer_id = ? AND status = 'ACTIVE' AND expiry_time > ?
       ORDER BY expiry_time DESC LIMIT 1`
    )
    .get(customerId, paidAtUtc);

  const hours = units * pkg.duration_hours;

  if (active) {
    db.prepare(
      `UPDATE subscriptions
       SET expiry_time = datetime(expiry_time, '+' || ? || ' hours'),
           package_id = ?, package_name_snapshot = ?, price_snapshot = ?,
           duration_hours_snapshot = ?, updated_at = ?
       WHERE id = ?`
    ).run(hours, pkg.id, pkg.name, pkg.price, pkg.duration_hours, paidAtUtc, active.id);
    return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(active.id);
  }

  const result = db
    .prepare(
      `INSERT INTO subscriptions
         (customer_id, package_id, package_name_snapshot, price_snapshot,
          duration_hours_snapshot, start_time, expiry_time, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime(?, '+' || ? || ' hours'), 'ACTIVE', ?, ?)`
    )
    .run(
      customerId, pkg.id, pkg.name, pkg.price, pkg.duration_hours,
      paidAtUtc, paidAtUtc, hours, paidAtUtc, paidAtUtc
    );
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(result.lastInsertRowid);
}

function upsertCustomer(name, phone, firstSeenUtc) {
  const existing = db.prepare('SELECT * FROM customers WHERE phone_number = ?').get(phone);
  if (existing) return existing;
  const result = db
    .prepare(
      `INSERT INTO customers (name, phone_number, room_identifier, device_name, mac_address, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, NULL, ?, ?)`
    )
    .run(name, phone, firstSeenUtc, firstSeenUtc);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(result.lastInsertRowid);
}

function main() {
  const already = new Set(
    db.prepare('SELECT reference_code FROM payments').all().map((r) => r.reference_code)
  );
  const pending = TRANSACTIONS.filter((t) => !already.has(t.code));
  if (pending.length === 0) {
    console.log('All M-PESA transactions are already recorded. Nothing to do.');
    return;
  }

  let insertedPayments = 0;
  let insertedCustomers = 0;
  const run = db.transaction(() => {
    // Oldest first so extensions chain correctly.
    for (const t of [...pending].sort((a, b) => new Date(a.at) - new Date(b.at))) {
      const paidAtUtc = toSqliteUtc(new Date(t.at));
      const before = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
      const customer = upsertCustomer(t.name, t.phone, paidAtUtc);
      if (db.prepare('SELECT COUNT(*) AS n FROM customers').get().n > before) insertedCustomers++;

      const pkg = pickPackage(t.amount);
      const units = Math.round(t.amount / pkg.price);
      const subscription = createOrExtendSubscriptionAt(customer.id, pkg, units, paidAtUtc);

      db.prepare(
        `INSERT INTO payments
           (customer_id, package_id, subscription_id, amount, payment_method,
            reference_code, status, paid_at, created_at)
         VALUES (?, ?, ?, ?, 'M-PESA', ?, 'VERIFIED', ?, ?)`
      ).run(customer.id, pkg.id, subscription.id, t.amount, t.code, paidAtUtc, paidAtUtc);
      insertedPayments++;
    }
    // Flip anything that has expired since (e.g. subscriptions that lapsed days ago).
    sweepExpired();
  });
  run();

  console.log(`Backfill complete: ${insertedPayments} payment(s) recorded, ${insertedCustomers} new customer(s).`);
  console.log('Per-customer summary:');
  const rows = db
    .prepare(
      `SELECT c.name, c.phone_number, COUNT(p.id) AS payments, COALESCE(SUM(p.amount),0) AS total,
             (SELECT status FROM subscriptions s WHERE s.customer_id = c.id ORDER BY s.expiry_time DESC LIMIT 1) AS latest_status,
             (SELECT expiry_time FROM subscriptions s WHERE s.customer_id = c.id ORDER BY s.expiry_time DESC LIMIT 1) AS latest_expiry
       FROM customers c LEFT JOIN payments p ON p.customer_id = c.id
       GROUP BY c.id ORDER BY c.name`
    )
    .all();
  for (const r of rows) {
    console.log(`  ${r.name} (${r.phone_number}): ${r.payments} payment(s), KSh ${r.total} — latest sub ${r.latest_status}, expires ${r.latest_expiry}`);
  }
}

main();
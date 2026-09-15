const db = require('../db');

// Lazily flips any ACTIVE subscription whose expiry has passed to EXPIRED.
// Cheap enough to run on every dashboard/customer read at this scale — no cron needed.
function sweepExpired() {
  db.prepare(
    `UPDATE subscriptions
     SET status = 'EXPIRED', updated_at = datetime('now')
     WHERE status = 'ACTIVE' AND expiry_time <= datetime('now')`
  ).run();
}

function getActiveSubscriptionForCustomer(customerId) {
  sweepExpired();
  return db
    .prepare(
      `SELECT * FROM subscriptions
       WHERE customer_id = ? AND status = 'ACTIVE'
       ORDER BY expiry_time DESC LIMIT 1`
    )
    .get(customerId);
}

// Core rule: if the customer already has a live ACTIVE subscription, extend its
// expiry by the new package's duration. Otherwise, start a fresh subscription now.
// Returns the subscription row that the payment should be linked to.
function createOrExtendSubscription({ customerId, pkg }) {
  sweepExpired();
  const active = getActiveSubscriptionForCustomer(customerId);

  if (active) {
    db.prepare(
      `UPDATE subscriptions
       SET expiry_time = datetime(expiry_time, '+' || ? || ' hours'),
           package_id = ?,
           package_name_snapshot = ?,
           price_snapshot = ?,
           duration_hours_snapshot = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(pkg.duration_hours, pkg.id, pkg.name, pkg.price, pkg.duration_hours, active.id);
    return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(active.id);
  }

  const insert = db.prepare(
    `INSERT INTO subscriptions
       (customer_id, package_id, package_name_snapshot, price_snapshot,
        duration_hours_snapshot, start_time, expiry_time, status)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now', '+' || ? || ' hours'), 'ACTIVE')`
  );
  const result = insert.run(
    customerId,
    pkg.id,
    pkg.name,
    pkg.price,
    pkg.duration_hours,
    pkg.duration_hours
  );
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(result.lastInsertRowid);
}

function listActiveWithCustomers() {
  sweepExpired();
  return db
    .prepare(
      `SELECT s.*, c.name AS customer_name, c.device_name, c.phone_number, c.mac_address, c.room_identifier
       FROM subscriptions s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.status = 'ACTIVE'
       ORDER BY s.expiry_time ASC`
    )
    .all();
}

function listRecentlyExpiredWithCustomers(hoursLimit = 48) {
  sweepExpired();
  return db
    .prepare(
      `SELECT s.*, c.name AS customer_name, c.device_name, c.phone_number, c.mac_address, c.room_identifier
       FROM subscriptions s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.status = 'EXPIRED'
         AND s.expiry_time >= datetime('now', '-' || ? || ' hours')
         AND s.customer_id NOT IN (
           SELECT customer_id FROM subscriptions WHERE status = 'ACTIVE'
         )
       ORDER BY s.expiry_time DESC`
    )
    .all(hoursLimit);
}

function listSubscriptionHistoryForCustomer(customerId) {
  return db
    .prepare(
      `SELECT * FROM subscriptions WHERE customer_id = ? ORDER BY created_at DESC`
    )
    .all(customerId);
}

module.exports = {
  sweepExpired,
  getActiveSubscriptionForCustomer,
  createOrExtendSubscription,
  listActiveWithCustomers,
  listRecentlyExpiredWithCustomers,
  listSubscriptionHistoryForCustomer,
};

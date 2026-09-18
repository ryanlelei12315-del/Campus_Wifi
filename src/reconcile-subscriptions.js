// Rebuilds the subscription chain from the payments ledger.
//
// The payments table is the immutable source of truth (one row per M-PESA SMS,
// with the real code, amount and paid_at). Subscriptions are DERIVED state: a
// customer's access windows are a pure function of when they paid and how much.
// Earlier ad-hoc form entries had left subscriptions that did not match the SMS
// history (e.g. a 48h window starting at a KSh30 payment), so this script wipes
// and replays the chain deterministically.
//
// Rules (same semantics as the live payment flow, anchored to paid_at):
//   - amount -> package: largest active package whose price divides the amount
//     evenly; overpayment buys multiple units (KSh60 -> 2 x 24 Hours = 48h).
//   - if the customer already has an ACTIVE subscription whose expiry is still
//     in the future at the moment of payment, extend that subscription;
//     otherwise open a fresh subscription starting at the payment time.
//   - every payment is (re)linked to the subscription it produced.
//
// Safe to re-run at any time: it is fully idempotent and transactional.
//
// Run: node src/reconcile-subscriptions.js
require('dotenv').config();
const db = require('./db');
const { sweepExpired } = require('./services/subscriptionService');
const { syncQuietly } = require('./services/subscriberSync');

// Largest active package that the amount can buy whole units of.
function pickPackage(amount) {
  const candidates = db
    .prepare('SELECT * FROM packages WHERE is_active = 1 AND price <= ? ORDER BY price DESC')
    .all(amount);
  if (candidates.length === 0) throw new Error(`No package matches amount ${amount}`);
  return candidates.find((p) => amount % p.price === 0) || candidates[candidates.length - 1];
}

function main() {
  const payments = db
    .prepare(
      `SELECT * FROM payments
       WHERE status = 'VERIFIED'
       ORDER BY paid_at ASC, id ASC`
    )
    .all();

  if (payments.length === 0) {
    console.log('No verified payments — nothing to reconcile.');
    return;
  }

  let created = 0;
  let extended = 0;

  const replay = db.transaction(() => {
    // Detach and drop the derived state, then rebuild it from scratch.
    db.prepare('UPDATE payments SET subscription_id = NULL').run();
    db.prepare('DELETE FROM subscriptions').run();

    const findLive = db.prepare(
      `SELECT * FROM subscriptions
       WHERE customer_id = ? AND status = 'ACTIVE' AND expiry_time > ?
       ORDER BY expiry_time DESC LIMIT 1`
    );
    const openNew = db.prepare(
      `INSERT INTO subscriptions
         (customer_id, package_id, package_name_snapshot, price_snapshot,
          duration_hours_snapshot, start_time, expiry_time, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime(?, '+' || ? || ' hours'), 'ACTIVE', ?, ?)`
    );
    const extend = db.prepare(
      `UPDATE subscriptions
       SET expiry_time = datetime(expiry_time, '+' || ? || ' hours'),
           package_id = ?, package_name_snapshot = ?, price_snapshot = ?,
           duration_hours_snapshot = ?, updated_at = ?
       WHERE id = ?`
    );
    const linkPayment = db.prepare('UPDATE payments SET subscription_id = ? WHERE id = ?');

    for (const p of payments) {
      const pkg = pickPackage(p.amount);
      const units = Math.round(p.amount / pkg.price);
      const hours = units * pkg.duration_hours;

      const live = findLive.get(p.customer_id, p.paid_at);
      let subscriptionId;
      if (live) {
        extend.run(hours, pkg.id, pkg.name, pkg.price, pkg.duration_hours, p.paid_at, live.id);
        subscriptionId = live.id;
        extended++;
      } else {
        const res = openNew.run(
          p.customer_id, pkg.id, pkg.name, pkg.price, pkg.duration_hours,
          p.paid_at, p.paid_at, hours, p.paid_at, p.paid_at
        );
        subscriptionId = res.lastInsertRowid;
        created++;
      }
      linkPayment.run(subscriptionId, p.id);
    }

    sweepExpired();
  });

  replay();

  // Push the freshly rebuilt chain into the table the WhatsApp scheduler reads.
  syncQuietly('reconcile');

  const orphans = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE subscription_id IS NULL').get().n;
  console.log(
    `Reconciled ${payments.length} payment(s): ${created} subscription(s) opened, ${extended} extended.`
  );
  console.log(`Unlinked payments remaining: ${orphans}`);
  console.log('Per-customer access history:');
  const rows = db
    .prepare(
      `SELECT c.name, c.phone_number, s.id AS sub_id, s.package_name_snapshot, s.start_time,
              s.expiry_time, s.status,
              (SELECT COUNT(*) FROM payments p WHERE p.subscription_id = s.id) AS payments,
              (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.subscription_id = s.id) AS paid
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id
       ORDER BY c.name, s.start_time`
    )
    .all();
  let last = null;
  for (const r of rows) {
    if (r.name !== last) {
      console.log(`  ${r.name} (${r.phone_number})`);
      last = r.name;
    }
    console.log(
      `    #${r.sub_id} ${r.package_name_snapshot}: ${r.start_time} -> ${r.expiry_time} ` +
        `[${r.status}] — ${r.payments} payment(s), KSh ${r.paid}`
    );
  }
}

main();
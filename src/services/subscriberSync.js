// Bridges the normalized ledger (customers + payments + subscriptions) into
// wifi_subscribers — the denormalized "hot table" the WhatsApp alert scheduler
// reads (see alertScheduler.js).
//
// Why this exists: payments are the source of truth, but the alert engine only
// knows about wifi_subscribers. Nothing else repopulates that table, so real
// M-PESA customers would never be alerted. This module derives one row per
// alertable customer from their *current* access state.
//
// A customer can only be alerted if the alert is actually actionable, which
// means two things must be true:
//   1. phone_number normalizes to a real WhatsApp-capable Kenyan number
//      (M-PESA statements mask numbers as "0701***357" — those cannot be
//      messaged, so the row is skipped and reported instead of silently failing
//      inside the scheduler forever).
//   2. mac_address is present, because the expiration milestone ends in a
//      terminal "🚨 [DISCONNECT REQ] Remove MAC ..." instruction for the admin.
//
// Everything else is skipped and surfaced by getSubscriberCoverage() so the
// admin sees exactly which field to fill in on the customer record.
//
// Idempotent and transactional: safe to re-run at any time (on boot, after a
// payment, after a reconcile). Re-running NEVER re-sends an alert, because
// warning_sent is only re-armed when the expiry actually moves.

const db = require('../db');
const { normalizeMac } = require('../utils/normalizeMac');
const { normalizeKenyanPhone } = require('./whatsappService');
const { sweepExpired } = require('./subscriptionService');

// A customer's current access state is their *latest* subscription: a live
// ACTIVE one if they have it, otherwise the most recently expired one.
const LATEST_SUBSCRIPTION_SQL = `
  SELECT * FROM subscriptions
  WHERE customer_id = ?
  ORDER BY (status = 'ACTIVE') DESC, expiry_time DESC
  LIMIT 1`;

function nowUtc() {
  return db.prepare("SELECT datetime('now') AS now").get().now;
}

function paidForSubscription(subscriptionId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM payments WHERE subscription_id = ? AND status = 'VERIFIED'`
    )
    .get(subscriptionId).total;
}

/**
 * Works out whether a customer can be alerted right now, and if so, what their
 * wifi_subscribers row should contain. Pure read — never writes.
 */
function evaluateCustomer(customer) {
  const mac = normalizeMac(customer.mac_address);
  const phone = normalizeKenyanPhone(customer.phone_number);
  const subscription = db.prepare(LATEST_SUBSCRIPTION_SQL).get(customer.id);

  const blockers = [];
  if (!mac) blockers.push('no MAC address on file (needed to remove the device from the CPE)');
  if (!phone) {
    blockers.push(
      `phone "${customer.phone_number}" is not a full WhatsApp-capable number ` +
        '(M-PESA statements mask it, e.g. 0701***357)'
    );
  }
  if (!subscription) blockers.push('no payment recorded for this customer yet');
  if (customer.account_status === 'DISABLED') blockers.push('customer account is DISABLED');

  if (blockers.length > 0) {
    return {
      customer,
      eligible: false,
      blockers,
      subscription,
      mac,
      phone,
      amount_paid: 0,
      start_time: null,
      expiry_time: null,
      status: 'Expired',
    };
  }

  // The scheduler only ever sends the one-shot expiration notice to rows that
  // are still 'Active'. Writing 'Active' for an already-lapsed customer would
  // fire a spurious "your access has now EXPIRED" WhatsApp on every boot, so
  // lapsed customers are written straight to 'Expired' and left alone.
  const liveNow = subscription.status === 'ACTIVE' && subscription.expiry_time > nowUtc();
  const paid = paidForSubscription(subscription.id);

  return {
    customer,
    eligible: true,
    blockers: [],
    subscription,
    mac,
    phone,
    // What this customer actually paid for the current access window; falls
    // back to the package price snapshot for legacy rows with no linked payment.
    amount_paid: paid > 0 ? paid : subscription.price_snapshot,
    start_time: subscription.start_time,
    expiry_time: subscription.expiry_time,
    status: liveNow ? 'Active' : 'Expired',
  };
}

/**
 * Read-only view of who can and cannot be alerted, for display in the UI.
 */
function getSubscriberCoverage() {
  sweepExpired();
  const customers = db.prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE ASC').all();
  const evaluated = customers.map(evaluateCustomer);
  return {
    totalCustomers: customers.length,
    eligible: evaluated.filter((e) => e.eligible),
    blocked: evaluated.filter((e) => !e.eligible),
  };
}

// Upsert keyed on MAC (the table's natural unique key). On conflict, an
// unchanged expiry keeps warning_sent so a re-run stays silent; a moved expiry
// means the customer renewed, so the flag is re-armed for the next cycle.
const UPSERT_SQL = `
  INSERT INTO wifi_subscribers
    (customer_id, customer_name, phone_number, mac_address, amount_paid,
     start_time, expiry_time, warning_sent, status)
  VALUES
    (@customer_id, @customer_name, @phone_number, @mac_address, @amount_paid,
     @start_time, @expiry_time, 0, @status)
  ON CONFLICT(mac_address) DO UPDATE SET
    customer_id   = excluded.customer_id,
    customer_name = excluded.customer_name,
    phone_number  = excluded.phone_number,
    amount_paid   = excluded.amount_paid,
    start_time    = excluded.start_time,
    expiry_time   = excluded.expiry_time,
    status        = excluded.status,
    warning_sent  = CASE
                      WHEN wifi_subscribers.expiry_time = excluded.expiry_time
                        THEN wifi_subscribers.warning_sent
                      ELSE 0
                    END,
    updated_at    = datetime('now')`;

/**
 * Re-derives wifi_subscribers from the ledger.
 *
 * Rows it wrote previously (customer_id IS NOT NULL) that no longer qualify are
 * pruned, so a deleted/changed MAC never lingers as a stale alert target.
 * Hand-entered rows (customer_id IS NULL) are never deleted.
 *
 * @returns {{created:number, updated:number, removed:number,
 *            totalCustomers:number, eligible:Array, blocked:Array}}
 */
function syncWifiSubscribers() {
  const coverage = getSubscriberCoverage();
  const existingMacs = new Set(
    db.prepare('SELECT mac_address FROM wifi_subscribers').all().map((r) => r.mac_address)
  );

  let created = 0;
  let updated = 0;

  const run = db.transaction(() => {
    const upsert = db.prepare(UPSERT_SQL);

    for (const row of coverage.eligible) {
      upsert.run({
        customer_id: row.customer.id,
        customer_name: row.customer.name,
        phone_number: row.phone,
        mac_address: row.mac,
        amount_paid: row.amount_paid,
        start_time: row.start_time,
        expiry_time: row.expiry_time,
        status: row.status,
      });

      // A row can already exist for this MAC even on the "new" path, when the
      // upsert adopts a hand-entered row — count that as an update.
      if (existingMacs.has(row.mac)) updated++;
      else created++;
    }

    const macs = coverage.eligible.map((r) => r.mac);
    const prune = macs.length === 0
      ? db.prepare('DELETE FROM wifi_subscribers WHERE customer_id IS NOT NULL')
      : db.prepare(
          `DELETE FROM wifi_subscribers
           WHERE customer_id IS NOT NULL
             AND mac_address NOT IN (${macs.map(() => '?').join(', ')})`
        );
    return macs.length === 0 ? prune.run().changes : prune.run(...macs).changes;
  });

  const removed = run();

  return { created, updated, removed, ...coverage };
}

/**
 * Convenience wrapper for callers that only care about logging (scripts, the
 * payment flow): runs the sync and prints a one-line summary. Never throws, so
 * a sync hiccup can never fail the payment that triggered it.
 */
function syncQuietly(context = 'manual') {
  try {
    const report = syncWifiSubscribers();
    console.log(
      `[SUBSCRIBER SYNC:${context}] ${report.created} added, ${report.updated} refreshed, ` +
        `${report.removed} pruned — ${report.eligible.length}/${report.totalCustomers} customer(s) alertable` +
        (report.blocked.length > 0 ? `, ${report.blocked.length} skipped (missing data)` : '')
    );
    return report;
  } catch (err) {
    console.warn(`[SUBSCRIBER SYNC:${context}] failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  syncWifiSubscribers,
  syncQuietly,
  getSubscriberCoverage,
  evaluateCustomer,
};
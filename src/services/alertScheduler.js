// Background expiry-alert engine for wifi_subscribers.
//
// Runs a pass every 60 seconds:
//   Milestone 1 — "expiring soon": an Active subscriber with <=30 minutes left
//                 and warning_sent = 0 gets a polite WhatsApp payment reminder,
//                 then warning_sent is flagged to 1.
//   Milestone 2 — "expired": an Active subscriber whose expiry_time has passed
//                 gets an expiration notice, is toggled to status 'Expired',
//                 and the admin sees a terminal alert with the MAC to remove
//                 from the indoor CPE portal.
//
// Every row is processed independently: one failed WhatsApp send never blocks
// the others, and failed warnings are retried on the next tick (the flag is
// only set after the send succeeds). Started from server.js only.

const db = require('../db');
const { formatDateTime } = require('../utils/formatDate');
const { sendWhatsAppText } = require('./whatsappService');

const TICK_MS = 60 * 1000;
const WARNING_WINDOW_MINUTES = 30;
const CPE_PORTAL_URL = 'http://192.168.18.1'; // indoor CPE admin portal (manual MAC removal)

let timer = null;

function dueForWarning() {
  return db
    .prepare(
      `SELECT * FROM wifi_subscribers
       WHERE status = 'Active'
         AND warning_sent = 0
         AND expiry_time > datetime('now')
         AND expiry_time <= datetime('now', '+${WARNING_WINDOW_MINUTES} minutes')
       ORDER BY expiry_time ASC`
    )
    .all();
}

function dueForExpiration() {
  return db
    .prepare(
      `SELECT * FROM wifi_subscribers
       WHERE status = 'Active' AND expiry_time <= datetime('now')
       ORDER BY expiry_time ASC`
    )
    .all();
}

function warningText(row) {
  return (
    `Hello ${row.customer_name}! 👋\n\n` +
    `Your campus Wi-Fi session is about to expire at ${formatDateTime(row.expiry_time)} ` +
    `(less than ${WARNING_WINDOW_MINUTES} minutes left).\n\n` +
    `To stay connected without interruption, please send your payment now via M-PESA, ` +
    `then share the confirmation code with the admin. Thank you! 🙏`
  );
}

function expiredText(row) {
  return (
    `Hello ${row.customer_name},\n\n` +
    `Your campus Wi-Fi access has now EXPIRED (as of ${formatDateTime(row.expiry_time)}).\n\n` +
    `Kindly send your payment via M-PESA and share the confirmation code with the admin ` +
    `to get reconnected. Thank you for your support! 🙏`
  );
}

async function tick() {
  try {
    // --- Milestone 1: polite payment warning in the final 30 minutes ---
    for (const row of dueForWarning()) {
      const result = await sendWhatsAppText(row.phone_number, warningText(row));
      if (result.ok) {
        db.prepare('UPDATE wifi_subscribers SET warning_sent = 1 WHERE id = ?').run(row.id);
        console.log(`[SCHEDULER] ⏳ Warning sent to ${row.customer_name} (${row.phone_number}) — expires ${row.expiry_time}`);
      } else {
        console.warn(`[SCHEDULER] Warning send failed for ${row.customer_name}: ${result.error} — will retry next tick`);
      }
    }

    // --- Milestone 2: expiration notice + disconnect request ---
    for (const row of dueForExpiration()) {
      // The notice is best-effort: WhatsApp being down must not leave a stale
      // "Active" row (or skip the admin's disconnect alert) waiting for a retry.
      const result = await sendWhatsAppText(row.phone_number, expiredText(row));
      if (result.ok) {
        console.log(`[SCHEDULER] 🔔 Expiration notice sent to ${row.customer_name} (${row.phone_number})`);
      } else {
        console.warn(`[SCHEDULER] Expiration notice failed for ${row.customer_name}: ${result.error}`);
      }
      db.prepare(
        `UPDATE wifi_subscribers SET status = 'Expired' WHERE id = ? AND status = 'Active'`
      ).run(row.id);
      // Terminal alert for the admin — the actual MAC removal is manual.
      console.log(`🚨 [DISCONNECT REQ] Remove MAC: ${row.mac_address} from ${CPE_PORTAL_URL}`);
    }
  } catch (err) {
    console.error('[SCHEDULER] Tick failed unexpectedly:', err.message);
  }
}

function startAlertScheduler() {
  if (timer) return; // guard against double-start
  console.log(`[SCHEDULER] Expiry alerts active — scanning every ${TICK_MS / 1000}s (warning window: ${WARNING_WINDOW_MINUTES} min).`);
  timer = setInterval(tick, TICK_MS);
  timer.unref(); // never keep the process alive just for the scheduler
  tick(); // immediate first pass so nothing slips through after a restart
}

function stopAlertScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startAlertScheduler, stopAlertScheduler, tick };
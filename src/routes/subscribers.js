const express = require('express');
const db = require('../db');
const { toSqliteUtc } = require('../utils/formatDate');
const { normalizeMac } = require('../utils/normalizeMac');
const { normalizeKenyanPhone, isWhatsAppConfigured } = require('../services/whatsappService');
const { syncWifiSubscribers, getSubscriberCoverage } = require('../services/subscriberSync');

const router = express.Router();

// Manual package catalogue (KSh). Edit prices here — the form and the renew
// action both derive from this single source.
const PACKAGES = {
  '12h': { label: '12 Hours', hours: 12, price: 20 },
  '24h': { label: '24 Hours', hours: 24, price: 30 },
  '7d': { label: '7 Days', hours: 168, price: 150 },
};

function listSubscribers() {
  return db
    .prepare(
      `SELECT *,
              CASE WHEN status = 'Active' AND expiry_time <= datetime('now') THEN 1 ELSE 0 END AS stale
       FROM wifi_subscribers
       ORDER BY status = 'Active' DESC, expiry_time ASC`
    )
    .all();
}

// Every render of this page needs the subscriber list plus the ledger-coverage
// report, so the admin can see at a glance who can actually be alerted.
function renderIndex(res, { status = 200, error = null, success = null, formData = {} } = {}) {
  return res.status(status).render('subscribers/index', {
    subscribers: listSubscribers(),
    coverage: getSubscriberCoverage(),
    whatsappConfigured: isWhatsAppConfigured(),
    packages: PACKAGES,
    error,
    success,
    formData,
  });
}

router.get('/', (req, res) => renderIndex(res));

// Re-derives every row from the billing ledger (customers + payments +
// subscriptions). Hand-entered rows are left alone — see services/subscriberSync.js.
router.post('/sync', (req, res) => {
  const report = syncWifiSubscribers();
  const summary = [
    `${report.eligible.length} of ${report.totalCustomers} customer(s) alertable`,
    `${report.created} added`,
    `${report.updated} refreshed`,
    `${report.removed} pruned`,
  ];
  const skipped = report.blocked.length > 0
    ? ` ${report.blocked.length} skipped for missing data — see the panel below.`
    : '';
  return renderIndex(res, {
    success: `Synced from the billing ledger: ${summary.join(', ')}.${skipped}`,
  });
});

router.post('/', (req, res) => {
  const { customer_name, phone_number, mac_address, package_key } = req.body;
  const formData = { customer_name, phone_number, mac_address, package_key };

  const name = String(customer_name || '').trim();
  const phone = normalizeKenyanPhone(phone_number);
  const mac = normalizeMac(mac_address);
  const pkg = PACKAGES[package_key];

  const renderError = (message) => renderIndex(res, { status: 400, error: message, formData });

  if (!name) return renderError('Customer name is required.');
  if (!phone) return renderError('Enter a valid Kenyan phone number, e.g. 0712 345 678 or 254712345678.');
  if (!mac) return renderError('A MAC address is required (e.g. AA:BB:CC:DD:EE:FF).');
  if (!pkg) return renderError('Choose a valid package (12 Hours, 24 Hours or 7 Days).');

  const start = toSqliteUtc();
  try {
    db.prepare(
      `INSERT INTO wifi_subscribers
         (customer_name, phone_number, mac_address, amount_paid, start_time, expiry_time, warning_sent, status)
       VALUES (?, ?, ?, ?, ?, datetime(?, '+' || ? || ' hours'), 0, 'Active')`
    ).run(name, phone, mac, pkg.price, start, start, pkg.hours);
    res.redirect('/subscribers');
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed: wifi_subscribers.mac_address')) {
      return renderError(`MAC ${mac} is already subscribed to another customer.`);
    }
    return renderError('Could not save the subscriber. Please try again.');
  }
});

// One-click renewal: re-charges the same package the row was created with,
// extends from the current expiry (or now, if already lapsed), and re-arms the
// warning flag so the scheduler alerts again on the next cycle.
router.post('/:id/renew', (req, res) => {
  const row = db.prepare('SELECT * FROM wifi_subscribers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).send('Subscriber not found');

  // A ledger-derived row is a projection of the real billing ledger, so editing
  // it here would be silently reverted by the next sync — send the admin to the
  // payment flow instead, which moves the underlying subscription.
  if (row.customer_id) {
    return renderIndex(res, {
      status: 400,
      error:
        `${row.customer_name}'s row is derived from the billing ledger. Record the M-PESA ` +
        'payment for that customer instead — that extends the real subscription and cannot ' +
        'be overwritten by the next sync.',
    });
  }

  const durationHours = Math.max(1, Math.round((Date.parse(row.expiry_time + 'Z') - Date.parse(row.start_time + 'Z')) / 3600000));
  const pkg = Object.values(PACKAGES).find((p) => p.hours === durationHours);

  const active = row.status === 'Active' && row.expiry_time > toSqliteUtc();
  const base = active ? row.expiry_time : toSqliteUtc();

  db.prepare(
    `UPDATE wifi_subscribers
     SET expiry_time = datetime(?, '+' || ? || ' hours'),
         status = 'Active',
         warning_sent = 0,
         amount_paid = amount_paid + ?,
         start_time = CASE WHEN ? THEN ? ELSE start_time END,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    base,
    durationHours,
    pkg ? pkg.price : 0,
    active ? 0 : 1,
    active ? null : base,
    row.id
  );

  res.redirect('/subscribers');
});

module.exports = router;
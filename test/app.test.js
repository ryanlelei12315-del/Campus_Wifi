const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Use a temporary test database
const TEST_DB = path.join(__dirname, 'test.sqlite');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.DB_PATH = TEST_DB;
process.env.TIMEZONE = 'Africa/Nairobi';

const db = require('../src/db');
const { formatDateTime, parseDate } = require('../src/utils/formatDate');
const { recordPayment, PaymentError } = require('../src/services/paymentService');
const {
  getActiveSubscriptionForCustomer,
  listActiveWithCustomers,
  listRecentlyExpiredWithCustomers,
  sweepExpired,
} = require('../src/services/subscriptionService');
const { getOverview } = require('../src/services/dashboardService');
const { syncWifiSubscribers, getSubscriberCoverage } = require('../src/services/subscriberSync');

async function runTests() {
  console.log('Running Campus Wi-Fi test suite...');

  // 1. Seed Packages
  const packages = [
    { name: '1 Hour', price: 10, duration_hours: 1 },
    { name: '24 Hours', price: 50, duration_hours: 24 },
    { name: '7 Days', price: 250, duration_hours: 168 },
  ];
  const insertPkg = db.prepare('INSERT INTO packages (name, price, duration_hours) VALUES (@name, @price, @duration_hours)');
  packages.forEach((p) => insertPkg.run(p));
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM packages').get().n, 3);

  // 2. Date Formatting in Africa/Nairobi
  const formatted = formatDateTime('2026-09-15 06:00:00');
  assert(!formatted.includes('Invalid Date'));
  assert(formatted.includes('09:00')); // UTC 06:00 is EAT 09:00

  // 3. Customer Creation & MAC uniqueness
  const insertCust = db.prepare(
    `INSERT INTO customers (name, phone_number, room_identifier, device_name, mac_address)
     VALUES (?, ?, ?, ?, ?)`
  );
  const res1 = insertCust.run('Test Customer', '0712345678', 'Hostel Room 5', 'Phone', 'AA:BB:CC:11:22:33');
  const custId = res1.lastInsertRowid;
  assert(custId > 0);

  assert.throws(() => {
    insertCust.run('Imposter', '0799999999', 'Room 1', 'Phone', 'AA:BB:CC:11:22:33');
  }, /UNIQUE constraint failed: customers.mac_address/);

  // 4. Initial Payment & Subscription Activation
  const pkg24h = db.prepare("SELECT * FROM packages WHERE name = '24 Hours'").get();
  const payment1 = recordPayment({
    customerId: custId,
    packageId: pkg24h.id,
    amount: 50,
    referenceCode: 'TESTREF001',
  });
  assert.strictEqual(payment1.subscription.status, 'ACTIVE');

  // 5. Active Extension on Renewal
  const activeSub = getActiveSubscriptionForCustomer(custId);
  const originalExpiry = new Date(parseDate(activeSub.expiry_time).getTime());
  const pkg7d = db.prepare("SELECT * FROM packages WHERE name = '7 Days'").get();

  const renewal = recordPayment({
    customerId: custId,
    packageId: pkg7d.id,
    amount: 250,
    referenceCode: 'TESTREF002',
  });
  assert.strictEqual(renewal.subscription.id, activeSub.id);

  const extendedSub = getActiveSubscriptionForCustomer(custId);
  const newExpiry = new Date(parseDate(extendedSub.expiry_time).getTime());
  const diffHours = Math.round((newExpiry - originalExpiry) / (1000 * 60 * 60));
  assert.strictEqual(diffHours, 168);

  // 6. Duplicate Reference Code Guard
  assert.throws(() => {
    recordPayment({
      customerId: custId,
      packageId: pkg24h.id,
      amount: 50,
      referenceCode: 'TESTREF001',
    });
  }, /Reference code "TESTREF001" has already been recorded/);

  // 7. Expired Subscriptions & Router Disconnect Queue
  const res2 = insertCust.run('Expired User', '0700112233', 'Room 8', 'Laptop', 'EE:FF:11:22:33:44');
  const expiredCustId = res2.lastInsertRowid;
  db.prepare(
    `INSERT INTO subscriptions
       (customer_id, package_id, package_name_snapshot, price_snapshot, duration_hours_snapshot,
        start_time, expiry_time, status)
     VALUES (?, ?, '1 Hour', 10, 1, datetime('now', '-3 hours'), datetime('now', '-1 hours'), 'ACTIVE')`
  ).run(expiredCustId, 1);

  sweepExpired();
  const disconnects = listRecentlyExpiredWithCustomers(48);
  const found = disconnects.find((d) => d.customer_id === expiredCustId);
  assert(found);
  assert.strictEqual(found.mac_address, 'EE:FF:11:22:33:44');

  // 8. Overview & Nairobi Financials
  const overview = getOverview();
  assert.strictEqual(overview.todayRevenue, 300);
  assert.strictEqual(overview.activeCount, 1);
  assert.strictEqual(overview.activeSubscriptions[0].mac_address, 'AA:BB:CC:11:22:33');

  // 9. Ledger -> wifi_subscribers sync (the table the WhatsApp scheduler reads)
  const rowFor = (mac) => db.prepare('SELECT * FROM wifi_subscribers WHERE mac_address = ?').get(mac);

  const firstSync = syncWifiSubscribers();
  assert.strictEqual(firstSync.created, 2); // both seeded customers are alertable
  assert.strictEqual(firstSync.removed, 0);

  const liveRow = rowFor('AA:BB:CC:11:22:33');
  assert(liveRow, 'an ACTIVE customer should be enrolled automatically');
  assert.strictEqual(liveRow.customer_id, custId);
  assert.strictEqual(liveRow.phone_number, '254712345678'); // normalized for WhatsApp
  assert.strictEqual(liveRow.status, 'Active');
  assert.strictEqual(liveRow.warning_sent, 0);
  assert.strictEqual(liveRow.amount_paid, 300); // 50 + 250 for the current window

  // Re-running the sync is idempotent and never re-arms a warning that was sent.
  db.prepare("UPDATE wifi_subscribers SET warning_sent = 1 WHERE mac_address = 'AA:BB:CC:11:22:33'").run();
  const secondSync = syncWifiSubscribers();
  assert.strictEqual(secondSync.created, 0);
  assert.strictEqual(secondSync.updated, 2);
  assert.strictEqual(secondSync.removed, 0);
  assert.strictEqual(rowFor('AA:BB:CC:11:22:33').warning_sent, 1);

  // A lapsed customer is stored as 'Expired', never as 'Active' — otherwise the
  // one-shot expiration notice would be re-sent on every scheduler pass.
  const lapsedRow = rowFor('EE:FF:11:22:33:44');
  assert(lapsedRow, 'a lapsed customer should still be tracked for the disconnect request');
  assert.strictEqual(lapsedRow.status, 'Expired');

  // A renewal moves the expiry, which re-arms the warning for the new cycle.
  const pkg1h = db.prepare("SELECT * FROM packages WHERE name = '1 Hour'").get();
  recordPayment({
    customerId: custId,
    packageId: pkg1h.id,
    amount: 10,
    referenceCode: 'TESTREF003',
  });
  syncWifiSubscribers();
  const renewedRow = rowFor('AA:BB:CC:11:22:33');
  assert.strictEqual(renewedRow.warning_sent, 0);
  assert.strictEqual(renewedRow.amount_paid, 310);

  // A phone masked on the M-PESA statement cannot receive WhatsApp: the customer
  // is reported as blocked instead of being silently enrolled.
  const maskedId = insertCust.run('Masked Phone', '0701***357', 'Room 9', 'Phone', 'AB:CD:EF:12:34:56')
    .lastInsertRowid;
  recordPayment({
    customerId: maskedId,
    packageId: pkg24h.id,
    amount: 50,
    referenceCode: 'TESTREF004',
  });

  // A customer with no MAC cannot be acted on by the disconnect request.
  const noMacId = insertCust.run('No MAC', '0722111222', 'Room 10', 'Phone', null).lastInsertRowid;
  recordPayment({
    customerId: noMacId,
    packageId: pkg24h.id,
    amount: 50,
    referenceCode: 'TESTREF005',
  });

  const coverage = getSubscriberCoverage();
  assert(coverage.eligible.some((e) => e.customer.id === custId));
  const masked = coverage.blocked.find((e) => e.customer.id === maskedId);
  assert(masked && masked.blockers.join(' ').includes('WhatsApp'));
  const noMac = coverage.blocked.find((e) => e.customer.id === noMacId);
  assert(noMac && noMac.blockers.join(' ').includes('MAC'));

  syncWifiSubscribers();
  assert.strictEqual(rowFor('AB:CD:EF:12:34:56'), undefined); // masked: never enrolled

  // Hand-entered rows are never touched, and stale derived rows are pruned when
  // the customer stops qualifying (e.g. their MAC is cleared).
  db.prepare(
    `INSERT INTO wifi_subscribers
       (customer_name, phone_number, mac_address, amount_paid, start_time, expiry_time, warning_sent, status)
     VALUES ('Manual Walk-in', '254700000001', 'FF:EE:DD:CC:BB:AA', 20, datetime('now'),
             datetime('now', '+12 hours'), 0, 'Active')`
  ).run();

  const derivedId = insertCust.run('Temp Derived', '0733111222', 'Room 11', 'Phone', '11:22:33:44:55:66')
    .lastInsertRowid;
  recordPayment({
    customerId: derivedId,
    packageId: pkg24h.id,
    amount: 50,
    referenceCode: 'TESTREF006',
  });
  syncWifiSubscribers();
  assert(rowFor('11:22:33:44:55:66'), 'derived row should exist before the customer changes');

  db.prepare('UPDATE customers SET mac_address = NULL WHERE id = ?').run(derivedId);
  const pruneReport = syncWifiSubscribers();
  assert.strictEqual(pruneReport.removed, 1);
  assert.strictEqual(rowFor('11:22:33:44:55:66'), undefined);
  assert(rowFor('FF:EE:DD:CC:BB:AA'), 'a hand-entered row must survive the sync');

  // 10. Scheduler end-to-end: ledger -> sync -> WhatsApp alert
  // Stub the Evolution API so the suite never touches the network. The scheduler
  // destructures sendWhatsAppText at require time, so the stub must be installed
  // before alertScheduler is first required.
  const whatsapp = require('../src/services/whatsappService');
  // The UI banner and the sender must agree on what "configured" means, or the
  // admin would be told alerts are fine while every send is silently skipped.
  assert.strictEqual(
    whatsapp.isWhatsAppConfigured(),
    Boolean(
      process.env.EVOLUTION_API_URL &&
        process.env.EVOLUTION_API_KEY &&
        process.env.EVOLUTION_INSTANCE_NAME
    )
  );
  const outbox = [];
  let sendShouldFail = false;
  whatsapp.sendWhatsAppText = async (phone, text) => {
    if (sendShouldFail) return { ok: false, error: 'stub: Evolution API down' };
    outbox.push({ phone, text });
    return { ok: true };
  };
  const { tick } = require('../src/services/alertScheduler');

  const alertCustId = insertCust.run('Alert Target', '0722333444', 'Room 12', 'Phone', 'AA:11:BB:22:CC:33')
    .lastInsertRowid;
  recordPayment({
    customerId: alertCustId,
    packageId: pkg1h.id,
    amount: 10,
    referenceCode: 'TESTREF007',
  });
  syncWifiSubscribers();
  const alertRow = rowFor('AA:11:BB:22:CC:33');
  assert(alertRow && alertRow.status === 'Active');

  // Milestone 1: inside the final 30 minutes the customer gets one reminder.
  db.prepare("UPDATE wifi_subscribers SET expiry_time = datetime('now', '+10 minutes'), warning_sent = 0 WHERE id = ?")
    .run(alertRow.id);
  await tick();
  assert.strictEqual(outbox.length, 1);
  assert.strictEqual(outbox[0].phone, '254722333444'); // normalized, WhatsApp-ready
  assert(outbox[0].text.includes('about to expire'));
  assert.strictEqual(rowFor('AA:11:BB:22:CC:33').warning_sent, 1);
  assert.strictEqual(rowFor('AA:11:BB:22:CC:33').status, 'Active'); // still connected

  // Later ticks must not spam the same customer.
  await tick();
  assert.strictEqual(outbox.length, 1);

  // A failed send is retried next tick — the flag is only set after success.
  db.prepare('UPDATE wifi_subscribers SET warning_sent = 0 WHERE id = ?').run(alertRow.id);
  sendShouldFail = true;
  await tick();
  assert.strictEqual(outbox.length, 1);
  assert.strictEqual(rowFor('AA:11:BB:22:CC:33').warning_sent, 0);
  sendShouldFail = false;
  await tick();
  assert.strictEqual(outbox.length, 2);
  assert.strictEqual(rowFor('AA:11:BB:22:CC:33').warning_sent, 1);

  // Milestone 2: lapse -> expiration notice + terminal admin disconnect request.
  db.prepare("UPDATE wifi_subscribers SET expiry_time = datetime('now', '-5 minutes') WHERE id = ?").run(alertRow.id);
  const logs = [];
  const realLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await tick();
  } finally {
    console.log = realLog;
  }
  assert.strictEqual(outbox.length, 3);
  assert(outbox[2].text.includes('has now EXPIRED'));
  assert.strictEqual(rowFor('AA:11:BB:22:CC:33').status, 'Expired');
  const disconnect = logs.find((l) => l.includes('[DISCONNECT REQ]'));
  assert(disconnect, 'the admin must get a terminal disconnect alert with the MAC');
  assert(disconnect.includes('AA:11:BB:22:CC:33'));

  // The expiration notice is one-shot: it must never repeat on later ticks.
  await tick();
  assert.strictEqual(outbox.length, 3);

  // Nobody with a masked phone or a missing MAC is ever messaged.
  const alertablePhones = new Set(
    getSubscriberCoverage().eligible.map((e) => e.phone)
  );
  assert(outbox.every((m) => alertablePhones.has(m.phone)));

  // Cleanup test DB
  db.close();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

  console.log('All tests passed successfully!');
}

runTests().catch((err) => {
  console.error('Tests failed:', err);
  try { db.close(); } catch (_) {}
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  process.exit(1);
});

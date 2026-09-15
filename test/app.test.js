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

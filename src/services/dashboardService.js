const db = require('../db');
const { sweepExpired, listActiveWithCustomers, listRecentlyExpiredWithCustomers } = require('./subscriptionService');

function getOverview() {
  sweepExpired();

  // East Africa Time (EAT) is UTC+3. SQLite's date('now') is UTC, so we shift by +3 hours
  // so that payments made between 00:00 and 03:00 local time fall into the correct day/month.
  const todayRevenue = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM payments
       WHERE date(paid_at, '+3 hours') = date('now', '+3 hours') AND status = 'VERIFIED'`
    )
    .get().total;

  const monthRevenue = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM payments
       WHERE strftime('%Y-%m', paid_at, '+3 hours') = strftime('%Y-%m', 'now', '+3 hours') AND status = 'VERIFIED'`
    )
    .get().total;

  const monthExpenses = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM expenses
       WHERE strftime('%Y-%m', spent_at, '+3 hours') = strftime('%Y-%m', 'now', '+3 hours')`
    )
    .get().total;

  const activeCount = db.prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'ACTIVE'`).get().n;
  const totalCustomers = db.prepare(`SELECT COUNT(*) AS n FROM customers`).get().n;

  const expiringSoon = db
    .prepare(
      `SELECT COUNT(*) AS n FROM subscriptions
       WHERE status = 'ACTIVE' AND expiry_time <= datetime('now', '+30 minutes')`
    )
    .get().n;

  const recentlyExpired = listRecentlyExpiredWithCustomers(48);

  return {
    todayRevenue,
    monthRevenue,
    monthExpenses,
    monthProfit: monthRevenue - monthExpenses,
    activeCount,
    totalCustomers,
    expiringSoon,
    activeSubscriptions: listActiveWithCustomers(),
    recentlyExpired,
  };
}

module.exports = { getOverview };

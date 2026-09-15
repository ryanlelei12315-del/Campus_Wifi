const db = require('../db');
const { createOrExtendSubscription } = require('./subscriptionService');
const { toSqliteUtc } = require('../utils/formatDate');

class PaymentError extends Error {}

// The one function that implements your whole PAYMENT -> SUBSCRIPTION -> ACTIVE
// lifecycle for V1. Everything happens in a single SQLite transaction: either
// the payment and the subscription update both succeed, or neither does.
function recordPayment({ customerId, packageId, amount, referenceCode, paidAt }) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) throw new PaymentError('Customer not found.');

  const pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND is_active = 1').get(packageId);
  if (!pkg) throw new PaymentError('Package not found or disabled.');

  const trimmedRef = String(referenceCode || '').trim();
  if (!trimmedRef) throw new PaymentError('A payment reference code is required.');

  const numericAmount = Number(amount);
  if (!numericAmount || numericAmount <= 0) {
    throw new PaymentError('Payment amount must be greater than 0 KSh.');
  }

  const normalizedPaidAt = paidAt ? toSqliteUtc(paidAt) : toSqliteUtc();

  const run = db.transaction(() => {
    let paymentId;
    try {
      const insertPayment = db.prepare(
        `INSERT INTO payments
           (customer_id, package_id, amount, payment_method, reference_code, status, paid_at)
         VALUES (?, ?, ?, 'AIRTEL_MONEY', ?, 'VERIFIED', ?)`
      );
      const result = insertPayment.run(customerId, packageId, numericAmount, trimmedRef, normalizedPaidAt);
      paymentId = result.lastInsertRowid;
    } catch (err) {
      if (String(err.message).includes('UNIQUE constraint failed: payments.reference_code')) {
        throw new PaymentError(
          `Reference code "${trimmedRef}" has already been recorded. Check for a duplicate entry before proceeding.`
        );
      }
      throw err;
    }

    const subscription = createOrExtendSubscription({ customerId, pkg });

    db.prepare('UPDATE payments SET subscription_id = ? WHERE id = ?').run(subscription.id, paymentId);

    return { paymentId, subscription };
  });

  return run();
}

module.exports = { recordPayment, PaymentError };

const express = require('express');
const db = require('../db');
const { recordPayment, PaymentError } = require('../services/paymentService');

const router = express.Router();

router.get('/new', (req, res) => {
  const customers = db.prepare('SELECT id, name, phone_number FROM customers ORDER BY name ASC').all();
  const packages = db.prepare('SELECT * FROM packages WHERE is_active = 1 ORDER BY duration_hours ASC').all();
  res.render('payments/new', {
    customers,
    packages,
    error: null,
    prefillCustomerId: req.query.customer_id || null,
    formData: {},
  });
});

router.post('/', (req, res) => {
  const { customer_id, package_id, amount, reference_code } = req.body;
  const customers = db.prepare('SELECT id, name, phone_number FROM customers ORDER BY name ASC').all();
  const packages = db.prepare('SELECT * FROM packages WHERE is_active = 1 ORDER BY duration_hours ASC').all();

  const formData = {
    customer_id,
    package_id,
    amount,
    reference_code,
  };

  try {
    if (!customer_id || !package_id || !amount || !reference_code) {
      throw new PaymentError('All fields are required.');
    }
    recordPayment({
      customerId: Number(customer_id),
      packageId: Number(package_id),
      amount: Number(amount),
      referenceCode: reference_code,
    });
    res.redirect(`/customers/${customer_id}`);
  } catch (err) {
    if (err instanceof PaymentError) {
      return res.render('payments/new', {
        customers,
        packages,
        error: err.message,
        prefillCustomerId: customer_id,
        formData,
      });
    }
    throw err;
  }
});

module.exports = router;

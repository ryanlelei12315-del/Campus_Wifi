const express = require('express');
const db = require('../db');
const { normalizeMac } = require('../utils/normalizeMac');
const { listSubscriptionHistoryForCustomer, getActiveSubscriptionForCustomer } = require('../services/subscriptionService');

const router = express.Router();

router.get('/', (req, res) => {
  const customers = db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all();
  res.render('customers/list', { customers });
});

router.get('/new', (req, res) => {
  res.render('customers/new', { error: null, customer: {} });
});

router.post('/', (req, res) => {
  const { name, phone_number, room_identifier, device_name, mac_address } = req.body;
  const trimmedName = String(name || '').trim();
  const trimmedPhone = String(phone_number || '').trim();
  const normalizedMac = normalizeMac(mac_address);

  if (!trimmedName || !trimmedPhone) {
    return res.render('customers/new', {
      error: 'Name and phone number are required.',
      customer: { name, phone_number, room_identifier, device_name, mac_address },
    });
  }

  try {
    const result = db.prepare(
      `INSERT INTO customers (name, phone_number, room_identifier, device_name, mac_address)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      trimmedName,
      trimmedPhone,
      String(room_identifier || '').trim() || null,
      String(device_name || '').trim() || null,
      normalizedMac
    );
    res.redirect(`/customers/${result.lastInsertRowid}`);
  } catch (err) {
    const msg = String(err.message).includes('UNIQUE constraint failed: customers.mac_address')
      ? 'That MAC address is already registered to another customer.'
      : 'Could not save customer.';
    res.render('customers/new', {
      error: msg,
      customer: { name, phone_number, room_identifier, device_name, mac_address },
    });
  }
});

router.get('/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).send('Customer not found');

  const payments = db
    .prepare('SELECT * FROM payments WHERE customer_id = ? ORDER BY paid_at DESC')
    .all(customer.id);

  const subscriptionHistory = listSubscriptionHistoryForCustomer(customer.id);
  const activeSubscription = getActiveSubscriptionForCustomer(customer.id);

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) AS total_paid, COUNT(*) AS payment_count, MAX(paid_at) AS last_payment
       FROM payments WHERE customer_id = ? AND status = 'VERIFIED'`
    )
    .get(customer.id);

  res.render('customers/show', {
    customer,
    payments,
    subscriptionHistory,
    activeSubscription,
    totals,
  });
});

router.get('/:id/edit', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).send('Customer not found');

  res.render('customers/edit', { customer, error: null });
});

router.post('/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).send('Customer not found');

  const { name, phone_number, room_identifier, device_name, mac_address, account_status } = req.body;
  const trimmedName = String(name || '').trim();
  const trimmedPhone = String(phone_number || '').trim();
  const normalizedMac = normalizeMac(mac_address);
  const status = account_status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';

  if (!trimmedName || !trimmedPhone) {
    return res.render('customers/edit', {
      customer: { ...customer, name, phone_number, room_identifier, device_name, mac_address, account_status: status },
      error: 'Name and phone number are required.',
    });
  }

  try {
    db.prepare(
      `UPDATE customers
       SET name = ?,
           phone_number = ?,
           room_identifier = ?,
           device_name = ?,
           mac_address = ?,
           account_status = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      trimmedName,
      trimmedPhone,
      String(room_identifier || '').trim() || null,
      String(device_name || '').trim() || null,
      normalizedMac,
      status,
      customer.id
    );
    res.redirect(`/customers/${customer.id}`);
  } catch (err) {
    const msg = String(err.message).includes('UNIQUE constraint failed: customers.mac_address')
      ? 'That MAC address is already registered to another customer.'
      : 'Could not update customer.';
    res.render('customers/edit', {
      customer: { ...customer, name, phone_number, room_identifier, device_name, mac_address, account_status: status },
      error: msg,
    });
  }
});

module.exports = router;

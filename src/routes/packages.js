const express = require('express');
const db = require('../db');
const router = express.Router();


router.get('/', (req, res) => { const packages = db.prepare('SELECT * FROM packages ORDER BY duration_hours ASC, id ASC').all(); res.render('packages/list', { packages, error: null }); });
router.get('/new', (req, res) => res.render('packages/form', { package: {}, error: null, mode: 'create' }));
router.post('/', (req, res) => {
  const { name, price, duration_hours } = req.body;
  const pkg = { name: String(name || '').trim(), price: Number(price), duration_hours: Number(duration_hours) };
  if (!pkg.name || !Number.isFinite(pkg.price) || pkg.price < 0 || !Number.isFinite(pkg.duration_hours) || pkg.duration_hours <= 0) return res.status(400).render('packages/form', { package: { name, price, duration_hours }, error: 'Enter a name, a non-negative price and a duration greater than 0 hours.', mode: 'create' });
  db.prepare('INSERT INTO packages (name, price, duration_hours, is_active) VALUES (?, ?, ?, 1)').run(pkg.name, Math.round(pkg.price), pkg.duration_hours);
  res.redirect('/packages');
});
router.get('/:id/edit', (req, res) => { const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id); if (!pkg) return res.status(404).send('Package not found'); res.render('packages/form', { package: pkg, error: null, mode: 'edit' }); });
router.post('/:id', (req, res) => {
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id); if (!pkg) return res.status(404).send('Package not found');
  const name = String(req.body.name || '').trim(), price = Number(req.body.price), durationHours = Number(req.body.duration_hours), isActive = req.body.is_active === '1' ? 1 : 0;
  if (!name || !Number.isFinite(price) || price < 0 || !Number.isFinite(durationHours) || durationHours <= 0) return res.status(400).render('packages/form', { package: { ...pkg, name, price, duration_hours: durationHours, is_active: isActive }, error: 'Enter a name, a non-negative price and a duration greater than 0 hours.', mode: 'edit' });
  db.prepare('UPDATE packages SET name = ?, price = ?, duration_hours = ?, is_active = ? WHERE id = ?').run(name, Math.round(price), durationHours, isActive, pkg.id);
  res.redirect('/packages');
});
router.post('/:id/delete', (req, res) => {
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id); if (!pkg) return res.status(404).send('Package not found');
  const references = db.prepare('SELECT (SELECT COUNT(*) FROM payments WHERE package_id = ?) AS payments, (SELECT COUNT(*) FROM subscriptions WHERE package_id = ?) AS subscriptions').get(pkg.id, pkg.id);
  if (references.payments || references.subscriptions) db.prepare('UPDATE packages SET is_active = 0 WHERE id = ?').run(pkg.id); else db.prepare('DELETE FROM packages WHERE id = ?').run(pkg.id);
  res.redirect('/packages');
});
module.exports = router;
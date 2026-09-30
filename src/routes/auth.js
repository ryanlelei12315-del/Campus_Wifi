const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/login', (req, res) => {
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);

  if (!admin || !bcrypt.compareSync(password || '', admin.password_hash)) {
    return res.render('login', { error: 'Invalid username or password.' });
  }

  req.session.adminId = admin.id;
  res.redirect('/');
});

router.get('/settings', requireAuth, (req, res) => {
  const admin = db.prepare('SELECT id, username FROM admins WHERE id = ?').get(req.session.adminId);
  res.render('settings', { admin, error: null, success: null });
});

router.post('/settings', requireAuth, (req, res) => {
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
  const { username, current_password, new_password, confirm_password } = req.body;
  const nextUsername = String(username || '').trim();
  if (!admin) return res.redirect('/login');
  if (!nextUsername) return res.render('settings', { admin, error: 'Username is required.', success: null });
  if (!bcrypt.compareSync(current_password || '', admin.password_hash)) return res.render('settings', { admin, error: 'Current password is incorrect.', success: null });
  if (new_password || confirm_password) {
    if (!new_password || new_password.length < 8) return res.render('settings', { admin, error: 'New password must be at least 8 characters.', success: null });
    if (new_password !== confirm_password) return res.render('settings', { admin, error: 'New passwords do not match.', success: null });
  }
  const usernameTaken = db.prepare('SELECT id FROM admins WHERE username = ? AND id != ?').get(nextUsername, admin.id);
  if (usernameTaken) return res.render('settings', { admin, error: 'That username is already in use.', success: null });
  const hash = new_password ? bcrypt.hashSync(new_password, 12) : admin.password_hash;
  db.prepare('UPDATE admins SET username = ?, password_hash = ? WHERE id = ?').run(nextUsername, hash, admin.id);
  res.render('settings', { admin: { ...admin, username: nextUsername }, error: null, success: 'Admin credentials updated successfully.' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;

const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const packages = db.prepare('SELECT * FROM packages ORDER BY duration_hours ASC').all();
  res.render('packages/list', { packages });
});

module.exports = router;

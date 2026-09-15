const express = require('express');
const { getOverview } = require('../services/dashboardService');

const router = express.Router();

router.get('/', (req, res) => {
  const overview = getOverview();
  res.render('dashboard', { overview });
});

module.exports = router;

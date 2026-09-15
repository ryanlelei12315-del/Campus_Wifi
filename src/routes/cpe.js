const express = require('express');
const { getCpeStatus, rebootOutdoor } = require('../services/cpeService');
const { listActiveWithCustomers, sweepExpired } = require('../services/subscriptionService');

const router = express.Router();

// Centralized CPE management — live data from both gateways on one page.
router.get('/', (req, res) => {
  sweepExpired();
  res.render('cpe/index', {
    activeMacs: listActiveWithCustomers(),
  });
});

// JSON endpoint the page polls for the live snapshot (stations, signal, rates).
router.get('/status', async (req, res) => {
  try {
    res.json(await getCpeStatus());
  } catch (err) {
    res.status(500).json({ error: 'CPE query failed', message: err.message });
  }
});

// Outdoor CPE restart (guarded by the admin session like every other route).
router.post('/outdoor/reboot', async (req, res) => {
  try {
    await rebootOutdoor();
    res.json({ ok: true, message: 'Reboot command accepted — the outdoor CPE will be back in 1–2 minutes.' });
  } catch (err) {
    res.status(502).json({
      ok: false,
      auth: err.code === 'AUTH_FAILED',
      message: err.message || 'Reboot command failed',
    });
  }
});

module.exports = router;
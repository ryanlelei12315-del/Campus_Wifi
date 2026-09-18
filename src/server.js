require('dotenv').config();
const app = require('./app');
const { startAlertScheduler } = require('./services/alertScheduler');
const { syncQuietly } = require('./services/subscriberSync');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Campus Wi-Fi admin running on http://localhost:${PORT}`);
  // Refresh the alert table from the ledger before the first scheduler pass so a
  // restart never leaves the WhatsApp engine watching stale rows.
  syncQuietly('boot');
  startAlertScheduler();
});

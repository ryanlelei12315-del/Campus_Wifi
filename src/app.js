const path = require('path');
const express = require('express');
const session = require('express-session');
const { requireAuth, attachAdmin } = require('./middleware/auth');

const { formatDateTime } = require('./utils/formatDate');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const customerRoutes = require('./routes/customers');
const packageRoutes = require('./routes/packages');
const paymentRoutes = require('./routes/payments');
const cpeRoutes = require('./routes/cpe');
const subscriberRoutes = require('./routes/subscribers');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
    // Note: default in-memory session store is fine for a single admin at this
    // scale, but sessions reset on server restart and won't survive multiple
    // processes. Swap in connect-sqlite3 if that becomes annoying.
  })
);

app.use(attachAdmin);
app.use((req, res, next) => {
  res.locals.formatDateTime = formatDateTime;
  next();
});
app.use('/', authRoutes);

app.use(requireAuth);
app.use('/', dashboardRoutes);
app.use('/customers', customerRoutes);
app.use('/packages', packageRoutes);
app.use('/payments', paymentRoutes);
app.use('/cpe', cpeRoutes);
app.use('/subscribers', subscriberRoutes);

module.exports = app;

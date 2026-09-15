function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.redirect('/login');
}

function attachAdmin(req, res, next) {
  res.locals.isAuthenticated = Boolean(req.session && req.session.adminId);
  next();
}

module.exports = { requireAuth, attachAdmin };

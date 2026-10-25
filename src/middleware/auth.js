const jwt = require('jsonwebtoken');
const config = require('../config');
const M = require('../db/models');
const { unauthorized, forbidden, wrap } = require('../utils/errors');

const sign = (user) => jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

// Verifies JWT, reloads the user (so deactivation/role changes take effect immediately)
const authenticate = wrap(async (req, _res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    throw unauthorized('Session expired, please sign in again');
  }
  const u = await M.User.findById(payload.sub).lean();
  if (!u || !u.active) throw unauthorized('Account is deactivated');
  const e = await M.Employee.findOne({ user_id: u._id }).select('_id').lean();
  req.user = { id: u._id, email: u.email, role: u.role, name: u.name, employeeId: e ? e._id : null, mustChangePassword: u.must_change_password };
  // Force password change before anything else
  if (u.must_change_password) {
    const p = req.baseUrl + req.path;
    if (!p.endsWith('/auth/change-password') && !p.endsWith('/auth/me')) {
      throw forbidden('You must change your temporary password first');
    }
  }
  next();
});

const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(forbidden());
  next();
};

// Anyone with an employee record (HR + employees)
const requireEmployeeRecord = (req, _res, next) => {
  if (!req.user.employeeId) return next(forbidden('This action needs an employee profile'));
  next();
};

module.exports = { sign, authenticate, requireRole, requireEmployeeRecord };

const M = require('../db/models');
const config = require('../config');
const pw = require('../utils/password');
const { bad, unauthorized, conflict } = require('../utils/errors');
const { audit } = require('./audit');

const DEFAULT_LEAVE_TYPES = [
  { code: 'annual', name: 'Annual Leave', yearly_quota: 14, paid: true },
  { code: 'sick', name: 'Sick Leave', yearly_quota: 8, paid: true },
  { code: 'casual', name: 'Casual Leave', yearly_quota: 10, paid: true },
  { code: 'unpaid', name: 'Unpaid Leave', yearly_quota: null, paid: false },
];

async function setupStatus() {
  const s = await M.Settings.findById(1).lean();
  return { setup_done: s.setup_done, company_name: s.company_name };
}

async function runSetup({ company_name, admin_name, email, password }) {
  const weak = pw.checkStrength(password);
  if (weak) throw bad(weak);
  const hash = await pw.hash(password);
  // Atomic claim: only the first caller flips setup_done from false to true
  const claimed = await M.Settings.findOneAndUpdate({ _id: 1, setup_done: false }, { $set: { setup_done: true, company_name, updated_at: new Date() } });
  if (!claimed) throw conflict('Setup already completed');
  try {
    const user = await M.create(M.User, { email: email.toLowerCase(), password_hash: hash, role: 'admin', name: admin_name });
    for (const lt of DEFAULT_LEAVE_TYPES) {
      if (!(await M.LeaveType.exists({ code: lt.code }))) await M.create(M.LeaveType, lt);
    }
    await audit(user, 'setup', 'company', 1, null, { company_name, admin_email: email });
    return { id: user.id, email: user.email, role: user.role, name: user.name };
  } catch (e) {
    await M.Settings.updateOne({ _id: 1 }, { $set: { setup_done: false } }); // roll back the claim
    throw e;
  }
}

// First run via env (ADMIN_EMAIL / ADMIN_PASSWORD) so hosted installs need no manual step
async function bootstrapFromEnv() {
  const { adminEmail, adminPassword, adminName, companyName } = config.bootstrap;
  if (!adminEmail || !adminPassword) return;
  if ((await setupStatus()).setup_done) return;
  await runSetup({ company_name: companyName || 'My Company', admin_name: adminName, email: adminEmail, password: adminPassword });
  console.log('[setup] Admin account created from environment variables');
}

async function login(email, password) {
  const u = await M.User.findOne({ email: email.toLowerCase() }).lean();
  // Same message for unknown email and bad password
  if (!u || !(await pw.compare(password, u.password_hash))) throw unauthorized('Invalid email or password');
  if (!u.active) throw unauthorized('Account is deactivated. Contact your administrator.');
  await M.User.updateOne({ _id: u._id }, { $set: { last_login_at: new Date() } });
  return { id: u._id, role: u.role };
}

async function changePassword(userId, current, next) {
  const u = await M.User.findById(userId).lean();
  if (!(await pw.compare(current, u.password_hash))) throw bad('Current password is incorrect');
  const weak = pw.checkStrength(next);
  if (weak) throw bad(weak);
  if (current === next) throw bad('New password must differ from the current one');
  await M.User.updateOne({ _id: userId }, { $set: { password_hash: await pw.hash(next), must_change_password: false } });
}

async function me(userId) {
  const u = await M.User.findById(userId).lean();
  const e = await M.Employee.findOne({ user_id: userId }).select('_id code').lean();
  const s = await M.Settings.findById(1).lean();
  return {
    id: u._id, email: u.email, role: u.role, name: u.name, must_change_password: u.must_change_password,
    employee_id: e ? e._id : null, employee_code: e ? e.code : null, company_name: s.company_name,
  };
}

module.exports = { setupStatus, runSetup, bootstrapFromEnv, login, changePassword, me };

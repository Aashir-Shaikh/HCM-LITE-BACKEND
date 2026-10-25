const M = require('../db/models');
const pw = require('../utils/password');
const { notFound, forbidden, unprocessable } = require('../utils/errors');
const { audit } = require('./audit');

async function list(q) {
  const filter = q.role ? { role: q.role } : {};
  const users = await M.User.find(filter).sort({ _id: 1 }).lean();
  const emps = await M.Employee.find({ user_id: { $in: users.map((u) => u._id) } }).select('user_id code').lean();
  const byUser = new Map(emps.map((e) => [e.user_id, e]));
  return users.map((u) => ({
    id: u._id, email: u.email, name: u.name, role: u.role, active: u.active, must_change_password: u.must_change_password,
    last_login_at: u.last_login_at, created_at: u.created_at,
    employee_id: byUser.get(u._id)?._id ?? null, employee_code: byUser.get(u._id)?.code ?? null,
  }));
}

async function getTarget(actor, id) {
  const u = await M.User.findById(id).lean();
  if (!u) throw notFound('User not found');
  if (u._id === actor.id) throw forbidden('You cannot do this to your own account');
  return u;
}

async function setActive(actor, id, active) {
  const u = await getTarget(actor, id);
  if (u.role === 'admin') throw forbidden('Admin accounts cannot be deactivated here');
  await M.User.updateOne({ _id: id }, { $set: { active } });
  await audit(actor, active ? 'activate' : 'deactivate', 'user', id, { active: u.active }, { active });
  return { id, active };
}

async function resetPassword(actor, id) {
  const u = await getTarget(actor, id);
  if (u.role === 'admin') throw unprocessable('Admin passwords cannot be reset by another user');
  const temp = pw.tempPassword();
  await M.User.updateOne({ _id: id }, { $set: { password_hash: await pw.hash(temp), must_change_password: true } });
  await audit(actor, 'reset_password', 'user', id, null, { must_change_password: true });
  return { id, email: u.email, temporary_password: temp };
}

module.exports = { list, setActive, resetPassword };

const M = require('../db/models');
const settingsSvc = require('./settings');
const { withEmployee, nameMap } = require('./lookup');
const { workingDaysList, nowIn } = require('../utils/dates');
const { unprocessable, notFound, forbidden, conflict } = require('../utils/errors');
const { audit } = require('./audit');
const { notify, notifyRoles } = require('./notify');

async function countWorkingDays(start, end) {
  const s = await settingsSvc.get();
  const hol = await settingsSvc.getHolidaySet(start, end);
  return workingDaysList(start, end, s.weekend_days, hol);
}

// Per leave type: quota, approved, pending, remaining (for the given year)
async function balance(employeeId, year) {
  const types = await M.L(M.LeaveType.find().sort({ _id: 1 }));
  const reqs = await M.LeaveRequest.find({
    employee_id: employeeId, status: { $in: ['approved', 'pending'] }, start_date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` },
  }).lean();
  return types.map((t) => {
    const mine = reqs.filter((r) => r.leave_type_id === t.id);
    const used = mine.filter((r) => r.status === 'approved').reduce((a, r) => a + r.days, 0);
    const pending = mine.filter((r) => r.status === 'pending').reduce((a, r) => a + r.days, 0);
    return {
      leave_type_id: t.id, code: t.code, name: t.name, yearly_quota: t.yearly_quota, paid: t.paid, used, pending,
      remaining: t.yearly_quota == null ? null : t.yearly_quota - used,
      available: t.yearly_quota == null ? null : t.yearly_quota - used - pending,
    };
  });
}

async function apply(actor, p) {
  const type = await M.L(M.LeaveType.findById(p.leave_type_id));
  if (!type) throw unprocessable('Unknown leave type');
  if (p.end_date < p.start_date) throw unprocessable('End date is before start date');
  const s = await settingsSvc.get();
  const todayD = nowIn(s.timezone).date;
  if (p.start_date < todayD) throw unprocessable('Leave cannot start in the past (use an attendance correction instead)');
  if (p.start_date.slice(0, 4) !== p.end_date.slice(0, 4)) throw unprocessable('Leave cannot span two calendar years; split the request');

  const emp = await M.Employee.findById(actor.employeeId).select('join_date').lean();
  if (p.start_date < emp.join_date) throw unprocessable('Leave starts before your join date');

  const days = (await countWorkingDays(p.start_date, p.end_date)).length;
  if (days === 0) throw unprocessable('Selected dates contain no working days (weekends and holidays are skipped)');

  const overlap = await M.LeaveRequest.exists({ employee_id: actor.employeeId, status: { $in: ['pending', 'approved'] }, start_date: { $lte: p.end_date }, end_date: { $gte: p.start_date } });
  if (overlap) throw unprocessable('These dates overlap with another leave request');

  const bal = (await balance(actor.employeeId, Number(p.start_date.slice(0, 4)))).find((b) => b.leave_type_id === type.id);
  if (type.yearly_quota != null && days > bal.available) {
    throw unprocessable(`Not enough ${type.name} balance: requested ${days}, available ${bal.available}`);
  }

  const row = await M.create(M.LeaveRequest, { employee_id: actor.employeeId, leave_type_id: type.id, start_date: p.start_date, end_date: p.end_date, days, reason: p.reason || '' });
  await audit(actor, 'create', 'leave_request', row.id, null, row);
  // HR leave is decided by Admin; employee leave by HR
  await notifyRoles(actor.role === 'hr' ? ['admin'] : ['hr'], 'New leave request', `${actor.name} requested ${days} day(s) of ${type.name} (${p.start_date} to ${p.end_date})`, '/leave/approvals');
  return row;
}

async function decorateLeave(rows) {
  const withEmp = await withEmployee(rows);
  const types = await nameMap(M.LeaveType, rows.map((r) => r.leave_type_id));
  const codes = new Map((await M.LeaveType.find().lean()).map((t) => [t._id, t.code]));
  return withEmp.map((r) => ({ ...r, leave_type: types.get(r.leave_type_id), leave_code: codes.get(r.leave_type_id) }));
}

async function list(viewer, q) {
  const filter = {};
  if (viewer.role === 'employee' || q.mine === 'true' || q.mine === '1') filter.employee_id = viewer.employeeId;
  else if (q.employee_id) filter.employee_id = Number(q.employee_id);
  if (q.status) filter.status = String(q.status);
  if (q.department_id && viewer.role !== 'employee') {
    const ids = (await M.Employee.find({ department_id: Number(q.department_id) }).select('_id').lean()).map((e) => e._id);
    filter.employee_id = filter.employee_id ? (ids.includes(filter.employee_id) ? filter.employee_id : -1) : { $in: ids };
  }
  const rows = await decorateLeave(await M.L(M.LeaveRequest.find(filter).sort({ created_at: -1 }).limit(300)));
  return rows.sort((a, b) => (b.status === 'pending') - (a.status === 'pending'));
}

async function cancel(actor, id) {
  const l = await M.L(M.LeaveRequest.findById(id));
  if (!l) throw notFound('Leave request not found');
  if (l.employee_id !== actor.employeeId) throw forbidden('You can only cancel your own leave');
  if (!['pending', 'approved'].includes(l.status)) throw conflict(`Leave is already ${l.status}`);
  const s = await settingsSvc.get();
  if (l.status === 'approved' && l.start_date <= nowIn(s.timezone).date) throw unprocessable('Approved leave that has already started cannot be cancelled');
  await M.LeaveRequest.updateOne({ _id: id }, { $set: { status: 'cancelled' } });
  await audit(actor, 'cancel', 'leave_request', id, { status: l.status }, { status: 'cancelled' });
  return M.L(M.LeaveRequest.findById(id));
}

async function review(actor, id, approve, comment) {
  const l = (await decorateLeave([await M.L(M.LeaveRequest.findById(id))].filter(Boolean)))[0];
  if (!l) throw notFound('Leave request not found');
  if (l.status !== 'pending') throw conflict(`Leave is already ${l.status}`);
  if (l.employee_id === actor.employeeId) throw forbidden('You cannot review your own leave');
  if (l.employee_role === 'hr' && actor.role !== 'admin') throw forbidden('HR leave requests are approved by Admin');
  if (l.employee_role !== 'hr' && actor.role !== 'hr') throw forbidden('Only HR can review employee leave');

  if (approve) {
    // Re-check balance at approval time (state may have changed)
    const type = await M.L(M.LeaveType.findById(l.leave_type_id));
    if (type.yearly_quota != null) {
      const b = (await balance(l.employee_id, Number(l.start_date.slice(0, 4)))).find((x) => x.leave_type_id === type.id);
      if (b.used + l.days > type.yearly_quota) throw unprocessable('Approving would exceed the employee balance');
    }
  }
  // Atomic claim: only one reviewer can decide a pending request
  const claimed = await M.LeaveRequest.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status: approve ? 'approved' : 'rejected', reviewer_user_id: actor.id, review_comment: comment || null, reviewed_at: new Date() } },
    { new: true }
  ).lean();
  if (!claimed) throw conflict('Leave was already reviewed');
  await audit(actor, approve ? 'approve' : 'reject', 'leave_request', id, { status: 'pending' }, { status: claimed.status, comment });
  const emp = await M.Employee.findById(l.employee_id).select('user_id').lean();
  await notify(emp.user_id, `Leave ${claimed.status}`, `Your ${l.leave_type} leave (${l.start_date} to ${l.end_date}) was ${claimed.status}${comment ? ': ' + comment : ''}`, '/leave');
  return M.fix(claimed);
}

module.exports = { balance, apply, list, cancel, review, countWorkingDays };

// Derives the status of every calendar day for one employee. Shared by calendar, payroll and profile 360
// so the same rules (absent / on_leave / missing_checkout ...) apply everywhere.
const M = require('../db/models');
const settingsSvc = require('./settings');
const { eachDate, isWeekend, nowIn } = require('../utils/dates');

// check-out missing on a past day -> missing_checkout
const effStatus = (a, today) => (!a.check_out && a.date < today ? 'missing_checkout' : a.status);

async function buildCalendar(employeeId, from, to, settings) {
  const s = settings || (await settingsSvc.get());
  const today = nowIn(s.timezone).date;
  const emp = await M.Employee.findById(employeeId).select('join_date exit_date').lean();
  const att = await M.Attendance.find({ employee_id: employeeId, date: { $gte: from, $lte: to } }).lean();
  const leaves = await M.LeaveRequest.find({ employee_id: employeeId, status: 'approved', start_date: { $lte: to }, end_date: { $gte: from } }).lean();
  const types = new Map((await M.LeaveType.find().lean()).map((t) => [t._id, t]));
  const holidays = new Map((await M.Holiday.find({ date: { $gte: from, $lte: to } }).lean()).map((h) => [h.date, h.name]));
  const attMap = new Map(att.map((a) => [a.date, a]));

  return eachDate(from, to).map((date) => {
    const a = attMap.get(date);
    const out = { date, status: null };
    if (date < emp.join_date || (emp.exit_date && date > emp.exit_date)) return { ...out, status: 'not_employed' };
    const weekend = isWeekend(date, s.weekend_days);
    const holiday = holidays.get(date);
    const leave = leaves.find((l) => l.start_date <= date && l.end_date >= date);
    const lt = leave ? types.get(leave.leave_type_id) : null;
    if (a) return { ...out, status: effStatus(a, today), is_late: a.is_late, check_in: a.check_in, check_out: a.check_out, worked_hours: a.worked_hours, source: a.source, leave_type: lt && !weekend && !holiday ? lt.code : undefined };
    if (weekend) return { ...out, status: 'weekend' };
    if (holiday) return { ...out, status: 'holiday', holiday };
    if (leave) return { ...out, status: 'on_leave', leave_type: lt?.code, paid: lt ? lt.paid : true };
    if (date >= today) return { ...out, status: date === today ? 'pending' : 'upcoming' };
    return { ...out, status: 'absent' };
  });
}

module.exports = { buildCalendar, effStatus };

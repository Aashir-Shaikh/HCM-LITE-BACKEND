// All dashboard numbers are computed here, on the server, from MongoDB data.
// The AI tools call the same functions, so assistant answers always match the dashboards.
const M = require('../db/models');
const settingsSvc = require('./settings');
const { effStatus } = require('./daystatus');
const { nameMap } = require('./lookup');
const { nowIn, addDays, workingDaysList, diffDays } = require('../utils/dates');
const { unprocessable } = require('../utils/errors');

const r1 = (n) => Math.round(n * 10) / 10;
const pct = (a, b) => (b ? r1((a / b) * 100) : 0);
const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);

async function resolveFilters(q = {}) {
  const s = await settingsSvc.get();
  const today = nowIn(s.timezone).date;
  const from = q.from || today.slice(0, 8) + '01';
  const to = q.to || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw unprocessable('from/to must be YYYY-MM-DD');
  if (from > to) throw unprocessable('from must not be after to');
  if (diffDays(from, to) > 400) throw unprocessable('Date range too long (max 400 days)');
  const department_id = q.department_id ? Number(q.department_id) : null;
  return { from, to, department_id, today, settings: s };
}

// Employees employed at any time in [from, to] (optionally one department / one employee)
function employedFilter(from, to, departmentId, employeeId) {
  const f = { join_date: { $lte: to }, $or: [{ exit_date: null }, { exit_date: { $gte: from } }] };
  if (departmentId) f.department_id = departmentId;
  if (employeeId) f._id = employeeId;
  return f;
}

// One row per (date, department) with status counts for working days in range.
async function dayMatrix(f, employeeId = null) {
  const s = f.settings;
  const holidays = await settingsSvc.getHolidaySet(f.from, f.to);
  const dates = workingDaysList(f.from, f.to, s.weekend_days, holidays);
  if (!dates.length) return [];
  const emps = await M.Employee.find(employedFilter(f.from, f.to, f.department_id, employeeId)).select('join_date exit_date department_id').lean();
  const ids = emps.map((e) => e._id);
  const att = await M.Attendance.find({ employee_id: { $in: ids }, date: { $gte: f.from, $lte: f.to } }).lean();
  const attMap = new Map(att.map((a) => [`${a.employee_id}|${a.date}`, a]));
  const leaves = await M.LeaveRequest.find({ employee_id: { $in: ids }, status: 'approved', start_date: { $lte: f.to }, end_date: { $gte: f.from } }).lean();
  const leaveBy = new Map();
  for (const l of leaves) { const arr = leaveBy.get(l.employee_id) || []; arr.push(l); leaveBy.set(l.employee_id, arr); }
  const deptNames = await nameMap(M.Department, emps.map((e) => e.department_id));

  const out = new Map();
  for (const date of dates) {
    for (const e of emps) {
      if (e.join_date > date || (e.exit_date && e.exit_date < date)) continue;
      const key = `${date}|${e.department_id ?? 'none'}`;
      let r = out.get(key);
      if (!r) {
        r = { date, department_id: e.department_id, department: deptNames.get(e.department_id) || 'Unassigned', expected: 0, present: 0, late: 0, half_day: 0, missing_checkout: 0, on_leave: 0, absent: 0, late_flag: 0 };
        out.set(key, r);
      }
      r.expected++;
      const a = attMap.get(`${e._id}|${date}`);
      if (a) {
        const st = effStatus(a, f.today);
        if (st === 'present') r.present++;
        else if (st === 'late') r.late++;
        else if (st === 'half_day') r.half_day++;
        else if (st === 'missing_checkout') r.missing_checkout++;
        if (a.is_late) r.late_flag++;
      } else if ((leaveBy.get(e._id) || []).some((l) => l.start_date <= date && l.end_date >= date)) {
        r.on_leave++;
      } else if (date < f.today) {
        r.absent++;
      }
    }
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function rateOf(rows) {
  const num = sum(rows, 'present') + sum(rows, 'late') + sum(rows, 'missing_checkout') + 0.5 * sum(rows, 'half_day');
  // Days not yet recorded (today before check-in / future) are left out of the denominator
  const den = sum(rows, 'present') + sum(rows, 'late') + sum(rows, 'missing_checkout') + sum(rows, 'half_day') + sum(rows, 'absent');
  return { num, den, rate: pct(num, den) };
}

async function headcountAt(date, departmentId) {
  const f = { join_date: { $lte: date }, $or: [{ exit_date: null }, { exit_date: { $gte: date } }] };
  if (departmentId) f.department_id = departmentId;
  return M.Employee.countDocuments(f);
}

async function attrition(f, ytd = true) {
  const start = ytd ? f.to.slice(0, 4) + '-01-01' : f.from;
  const filter = { exit_date: { $gte: start, $lte: f.to } };
  if (f.department_id) filter.department_id = f.department_id;
  const exits = await M.Employee.countDocuments(filter);
  const avg = ((await headcountAt(start, f.department_id)) + (await headcountAt(f.to, f.department_id))) / 2;
  return { exits, average_headcount: r1(avg), percent: pct(exits, avg), from: start, to: f.to };
}

async function attendanceTrend(f) {
  const rows = await dayMatrix(f);
  const byDate = new Map();
  for (const r of rows) { const cur = byDate.get(r.date) || []; cur.push(r); byDate.set(r.date, cur); }
  return [...byDate.entries()].map(([date, rs]) => ({
    date, rate: rateOf(rs).rate,
    present: sum(rs, 'present') + sum(rs, 'late') + sum(rs, 'missing_checkout') + sum(rs, 'half_day'),
    absent: sum(rs, 'absent'), on_leave: sum(rs, 'on_leave'),
  }));
}

function byDepartment(rows) {
  const m = new Map();
  for (const r of rows) {
    const cur = m.get(r.department) || { department: r.department, department_id: r.department_id, expected: 0, present: 0, late: 0, half_day: 0, missing_checkout: 0, on_leave: 0, absent: 0 };
    for (const key of ['expected', 'present', 'late', 'half_day', 'missing_checkout', 'on_leave', 'absent']) cur[key] += r[key];
    m.set(r.department, cur);
  }
  return [...m.values()].map((d) => ({
    ...d, attendance_rate: rateOf([d]).rate, late_pct: pct(d.late, d.present + d.late), absenteeism_pct: pct(d.absent, d.expected),
  }));
}

async function attendanceSummary(f, employeeId = null) {
  const rows = await dayMatrix(f, employeeId);
  const r = rateOf(rows);
  return {
    from: f.from, to: f.to, department_id: f.department_id,
    attendance_rate: r.rate,
    present: sum(rows, 'present'), late: sum(rows, 'late'), half_day: sum(rows, 'half_day'), missing_checkout: sum(rows, 'missing_checkout'),
    on_leave: sum(rows, 'on_leave'), absent: sum(rows, 'absent'), expected_records: sum(rows, 'expected'),
    late_pct: pct(sum(rows, 'late'), sum(rows, 'present') + sum(rows, 'late')),
    absenteeism_pct: pct(sum(rows, 'absent'), sum(rows, 'expected')),
    by_department: employeeId ? undefined : byDepartment(rows),
  };
}

async function lateComers(f, limit = 5) {
  const filter = { is_late: true, date: { $gte: f.from, $lte: f.to } };
  if (f.department_id) {
    const ids = (await M.Employee.find({ department_id: f.department_id }).select('_id').lean()).map((e) => e._id);
    filter.employee_id = { $in: ids };
  }
  const counts = await M.Attendance.aggregate([{ $match: filter }, { $group: { _id: '$employee_id', late_count: { $sum: 1 } } }]);
  const emps = await M.Employee.find({ _id: { $in: counts.map((c) => c._id) } }).lean();
  const byId = new Map(emps.map((e) => [e._id, e]));
  const depts = await nameMap(M.Department, emps.map((e) => e.department_id));
  return counts
    .map((c) => {
      const e = byId.get(c._id);
      return { employee_id: c._id, code: e.code, name: `${e.first_name} ${e.last_name}`.trim(), department: depts.get(e.department_id) || null, late_count: c.late_count };
    })
    .sort((a, b) => b.late_count - a.late_count || a.name.localeCompare(b.name))
    .slice(0, Number(limit) || 5);
}

async function onLeaveList(date, departmentId, employeeId = null) {
  const leaves = await M.L(M.LeaveRequest.find({ status: 'approved', start_date: { $lte: date }, end_date: { $gte: date } }));
  const empFilter = { _id: { $in: leaves.map((l) => l.employee_id) } };
  if (departmentId) empFilter.department_id = departmentId;
  if (employeeId) empFilter._id = employeeId;
  const emps = await M.Employee.find(empFilter).lean();
  const byId = new Map(emps.map((e) => [e._id, e]));
  const depts = await nameMap(M.Department, emps.map((e) => e.department_id));
  const types = await nameMap(M.LeaveType, leaves.map((l) => l.leave_type_id));
  return leaves
    .filter((l) => byId.has(l.employee_id))
    .map((l) => {
      const e = byId.get(l.employee_id);
      return { employee_id: e._id, name: `${e.first_name} ${e.last_name}`.trim(), department: depts.get(e.department_id) || null, leave_type: types.get(l.leave_type_id), start_date: l.start_date, end_date: l.end_date };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function leaveSummary(f, employeeId = null) {
  const empFilter = {};
  if (f.department_id) empFilter.department_id = f.department_id;
  if (employeeId) empFilter._id = employeeId;
  const scoped = Object.keys(empFilter).length ? (await M.Employee.find(empFilter).select('_id').lean()).map((e) => e._id) : null;
  const scope = scoped ? { employee_id: { $in: scoped } } : {};

  const types = await M.L(M.LeaveType.find().sort({ _id: 1 }));
  const inRange = await M.LeaveRequest.find({ status: 'approved', start_date: { $lte: f.to }, end_date: { $gte: f.from }, ...scope }).lean();
  const year = f.to.slice(0, 4);
  const inYear = await M.LeaveRequest.find({ status: 'approved', start_date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` }, ...scope }).lean();
  const hc = employeeId ? 1 : await headcountAt(f.to, f.department_id);

  const utilization = types.map((t) => {
    const rangeRows = inRange.filter((l) => l.leave_type_id === t.id);
    const usedYear = inYear.filter((l) => l.leave_type_id === t.id).reduce((a, l) => a + l.days, 0);
    return {
      code: t.code, name: t.name, approved_days_in_range: rangeRows.reduce((a, l) => a + l.days, 0), requests: rangeRows.length,
      // Utilisation = approved days in the year / (quota x headcount)
      utilization_pct: t.yearly_quota ? pct(usedYear, t.yearly_quota * hc) : null,
    };
  });
  return { from: f.from, to: f.to, by_type: utilization, on_leave_today: await onLeaveList(f.today, f.department_id, employeeId) };
}

const grossOf = (e) => e.basic_salary * (1 + e.hra_pct / 100 + e.medical_pct / 100);

async function payrollSummary(f) {
  const fm = f.from.slice(0, 7), tm = f.to.slice(0, 7);
  const filter = { month: { $gte: fm, $lte: tm } };
  if (f.department_id) filter.department_id = f.department_id;
  const slips = await M.Payslip.find(filter).lean();
  const runs = new Map((await M.PayrollRun.find({ month: { $gte: fm, $lte: tm } }).lean()).map((r) => [r.month, r]));

  const months = new Map();
  const depts = new Map();
  for (const p of slips) {
    const m = months.get(p.month) || { month: p.month, status: runs.get(p.month)?.status, employees: 0, gross: 0, net: 0, tax: 0 };
    m.employees++; m.gross += p.gross; m.net += p.net; m.tax += p.tax;
    months.set(p.month, m);
    const d = depts.get(p.department_id) || { department_id: p.department_id, gross: 0, net: 0 };
    d.gross += p.gross; d.net += p.net;
    depts.set(p.department_id, d);
  }
  const deptNames = await nameMap(M.Department, [...depts.keys()]);
  const byMonth = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  const byDept = [...depts.values()].map((d) => ({ department: deptNames.get(d.department_id) || 'Unassigned', gross: d.gross, net: d.net })).sort((a, b) => b.gross - a.gross);

  const empFilter = { basic_salary: { $gt: 0 }, join_date: { $lte: f.to }, $or: [{ exit_date: null }, { exit_date: { $gte: f.to } }] };
  if (f.department_id) empFilter.department_id = f.department_id;
  const emps = await M.Employee.find(empFilter).lean();
  const dn = await nameMap(M.Department, emps.map((e) => e.department_id));
  const gn = await nameMap(M.Designation, emps.map((e) => e.designation_id));
  const groups = new Map();
  for (const e of emps) {
    const key = `${e.department_id}|${e.designation_id}`;
    const g = groups.get(key) || { department: dn.get(e.department_id) || 'Unassigned', designation: gn.get(e.designation_id) || 'Unassigned', employees: 0, total: 0 };
    g.employees++; g.total += grossOf(e);
    groups.set(key, g);
  }
  const avg = [...groups.values()].map((g) => ({ department: g.department, designation: g.designation, employees: g.employees, avg_gross: Math.round(g.total / g.employees) }))
    .sort((a, b) => a.department.localeCompare(b.department) || a.designation.localeCompare(b.designation));
  const overall = emps.length ? Math.round(emps.reduce((a, e) => a + grossOf(e), 0) / emps.length) : 0;

  return {
    from: f.from, to: f.to, total_gross: sum(byMonth, 'gross'), total_net: sum(byMonth, 'net'),
    average_salary_gross: overall, by_month: byMonth, by_department: byDept, average_salary_by_dept_designation: avg,
  };
}

async function pendingApprovals(role) {
  // HR approves employee requests; Admin approves HR requests
  const target = role === 'admin' ? 'hr' : 'employee';
  const ids = (await M.Employee.find({ role: target }).select('_id').lean()).map((e) => e._id);
  const leave = await M.LeaveRequest.countDocuments({ status: 'pending', employee_id: { $in: ids } });
  const corrections = await M.AttendanceCorrection.countDocuments({ status: 'pending', employee_id: { $in: ids } });
  return { leave, corrections, total: leave + corrections };
}

// Counted straight from today's records so weekend/holiday check-ins still show up
async function todayStats(f) {
  const filter = { date: f.today };
  if (f.department_id) {
    const ids = (await M.Employee.find({ department_id: f.department_id }).select('_id').lean()).map((e) => e._id);
    filter.employee_id = { $in: ids };
  }
  const recs = await M.Attendance.find(filter).select('is_late').lean();
  const onLeave = (await onLeaveList(f.today, f.department_id)).length;
  return { present: recs.length, late: recs.filter((r) => r.is_late).length, on_leave: onLeave };
}

// ---- dashboards ----------------------------------------------------------
async function hrDashboard(user, q) {
  const f = await resolveFilters(q);
  const [headcount, att, trend, late, leave, pending, today] = await Promise.all([
    headcountAt(f.today, f.department_id), attendanceSummary(f), attendanceTrend(f), lateComers(f, 5), leaveSummary(f),
    pendingApprovals(user.role), todayStats(f),
  ]);
  return {
    filters: { from: f.from, to: f.to, department_id: f.department_id },
    kpis: {
      headcount, present_today: today.present, on_leave_today: today.on_leave, late_today: today.late,
      pending_approvals: pending.total, attendance_rate: att.attendance_rate,
    },
    pending_approvals: pending,
    attendance_trend: trend,
    absenteeism_by_department: att.by_department.map((d) => ({ department: d.department, absenteeism_pct: d.absenteeism_pct, absent_days: d.absent, late_pct: d.late_pct, attendance_rate: d.attendance_rate })),
    leave_by_type: leave.by_type,
    on_leave_today: leave.on_leave_today,
    top_late_comers: late,
  };
}

async function adminDashboard(user, q) {
  const f = await resolveFilters(q);
  const [headcount, attr, pay, hrView, pending] = await Promise.all([
    headcountAt(f.to, f.department_id), attrition(f), payrollSummary(f), hrDashboard({ role: 'hr' }, q), pendingApprovals('admin'),
  ]);
  const active = await M.Employee.find({ ...{ join_date: { $lte: f.to }, $or: [{ exit_date: null }, { exit_date: { $gte: f.to } }] }, ...(f.department_id ? { department_id: f.department_id } : {}) }).lean();

  const tally = (items) => { const m = new Map(); items.forEach((k) => m.set(k, (m.get(k) || 0) + 1)); return m; };
  const gender = [...tally(active.map((e) => e.gender)).entries()].map(([g, count]) => ({ gender: g, count })).sort((a, b) => b.count - a.count);
  const bucketOf = (e) => { const y = diffDays(e.join_date, f.to) / 365.25; return y < 1 ? 'Under 1 year' : y < 3 ? '1-3 years' : y < 5 ? '3-5 years' : '5+ years'; };
  const tenure = [...tally(active.map(bucketOf)).entries()].map(([bucket, count]) => ({ bucket, count }));
  const dn = await nameMap(M.Department, active.map((e) => e.department_id));
  const headByDept = [...tally(active.map((e) => dn.get(e.department_id) || 'Unassigned')).entries()].map(([department, headcount]) => ({ department, headcount })).sort((a, b) => b.headcount - a.headcount);
  const audit = (await M.L(M.AuditLog.find().sort({ _id: -1 }).limit(10))).map(({ before, after, ...a }) => a);

  return {
    filters: { from: f.from, to: f.to, department_id: f.department_id },
    kpis: {
      headcount, attrition_ytd_pct: attr.percent, payroll_cost_gross: pay.total_gross, payroll_cost_net: pay.total_net,
      average_salary: pay.average_salary_gross, attendance_rate: hrView.kpis.attendance_rate, pending_hr_approvals: pending.total,
    },
    attrition: attr,
    headcount_by_department: headByDept,
    payroll_cost_by_department: pay.by_department,
    payroll_by_month: pay.by_month,
    average_salary_by_dept_designation: pay.average_salary_by_dept_designation,
    gender, tenure,
    attendance_trend: hrView.attendance_trend,
    audit_feed: audit,
  };
}

async function employeeDashboard(user) {
  const s = await settingsSvc.get();
  const now = nowIn(s.timezone);
  const eid = user.employeeId;
  const monday = addDays(now.date, -((new Date(now.date + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const weekRecs = await M.Attendance.find({ employee_id: eid, date: { $gte: monday, $lte: addDays(monday, 6) } }).lean();
  const hours = weekRecs.reduce((a, r) => a + (r.check_out ? r.worked_hours || 0 : (Date.now() - r.check_in) / 3600000), 0);
  const monthStart = now.date.slice(0, 8) + '01';
  const late = await M.Attendance.countDocuments({ employee_id: eid, is_late: true, date: { $gte: monthStart, $lte: now.date } });
  const leaveSvc = require('./leave');
  const balances = await leaveSvc.balance(eid, Number(now.date.slice(0, 4)));
  const finalized = new Map((await M.PayrollRun.find({ status: 'finalized' }).lean()).map((r) => [r._id, r]));
  const slips = (await M.Payslip.find({ employee_id: eid, run_id: { $in: [...finalized.keys()] } }).sort({ month: -1 }).limit(1).lean());
  const slip = slips[0] ? { id: slips[0]._id, month: slips[0].month, net: slips[0].net, gross: slips[0].gross } : null;
  const todayRec = await M.L(M.Attendance.findOne({ employee_id: eid, date: now.date }));
  const announcements = await M.L(M.Announcement.find().sort({ _id: -1 }).limit(5).select('title body created_at'));
  return {
    kpis: { hours_this_week: Math.round(hours * 10) / 10, weekly_target_hours: 40, late_count_this_month: late, last_payslip: slip },
    today: todayRec, leave_balance: balances, announcements,
  };
}

module.exports = {
  resolveFilters, dayMatrix, headcountAt, attrition, attendanceSummary, attendanceTrend, lateComers, leaveSummary, onLeaveList,
  payrollSummary, pendingApprovals, hrDashboard, adminDashboard, employeeDashboard,
};

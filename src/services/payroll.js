const M = require('../db/models');
const settingsSvc = require('./settings');
const { buildCalendar } = require('./daystatus');
const { withEmployee, nameMap } = require('./lookup');
const { monthRange, workingDaysList } = require('../utils/dates');
const { notFound, conflict, unprocessable, forbidden } = require('../utils/errors');
const { audit } = require('./audit');
const { notify } = require('./notify');

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Illustrative annual tax slab (PKR): 0 to 600k; 5% to 1.2M; 30k + 15% to 2.4M; 210k + 25% to 3.6M; 510k + 35% above
function annualTax(a) {
  if (a <= 600000) return 0;
  if (a <= 1200000) return (a - 600000) * 0.05;
  if (a <= 2400000) return 30000 + (a - 1200000) * 0.15;
  if (a <= 3600000) return 210000 + (a - 2400000) * 0.25;
  return 510000 + (a - 3600000) * 0.35;
}

async function computeSlip(emp, month, s, holidays) {
  const { from, to } = monthRange(month);
  const basic = Number(emp.basic_salary);
  const hra = r2((basic * emp.hra_pct) / 100);
  const medical = r2((basic * emp.medical_pct) / 100);
  const gross = r2(basic + hra + medical);

  const monthWorking = workingDaysList(from, to, s.weekend_days, holidays).length;
  const start = emp.join_date > from ? emp.join_date : from;
  const end = emp.exit_date && emp.exit_date < to ? emp.exit_date : to;
  const employed = workingDaysList(start, end, s.weekend_days, holidays).length;

  const days = start <= end ? await buildCalendar(emp._id, start, end, s) : [];
  const absent = days.filter((d) => d.status === 'absent').length;
  const half = days.filter((d) => d.status === 'half_day').length;
  const unpaid = days.filter((d) => d.status === 'on_leave' && d.paid === false).length;

  const perDay = monthWorking ? gross / monthWorking : 0;
  const earned = r2(perDay * employed); // joiners / leavers are prorated
  const deductions = r2(perDay * (absent + unpaid + 0.5 * half));
  const ratio = monthWorking ? employed / monthWorking : 0;
  const tax = r2((annualTax(gross * 12) / 12) * ratio);
  const net = r2(Math.max(0, earned - deductions - tax));

  return {
    employee_id: emp._id, department_id: emp.department_id, basic, hra, medical, gross,
    working_days: monthWorking, employed_days: employed, absent_days: absent, unpaid_days: unpaid, half_days: half,
    earned_gross: earned, deductions, tax, net,
  };
}

async function generate(actor, month) {
  const existing = await M.PayrollRun.findOne({ month }).lean();
  if (existing && existing.status === 'finalized') throw conflict(`Payroll for ${month} is finalized and locked`);

  const s = await settingsSvc.get();
  const { from, to } = monthRange(month);
  const holidays = await settingsSvc.getHolidaySet(from, to);
  const emps = await M.Employee.find({ join_date: { $lte: to }, $or: [{ exit_date: null }, { exit_date: { $gte: from } }], basic_salary: { $gt: 0 } }).sort({ _id: 1 }).lean();
  if (!emps.length) throw unprocessable('No employees with a salary structure are employed in this month');

  const slips = [];
  for (const e of emps) slips.push(await computeSlip(e, month, s, holidays));

  let runId;
  if (existing) runId = existing._id;
  else runId = (await M.create(M.PayrollRun, { month, created_by: actor.id })).id; // month is unique: a racing second create gets 409
  // Re-check the lock right before rewriting (finalize may have happened meanwhile)
  const run = await M.PayrollRun.findById(runId).lean();
  if (run.status === 'finalized') throw conflict(`Payroll for ${month} is finalized and locked`);
  await M.Payslip.deleteMany({ run_id: runId });
  await M.createMany(M.Payslip, slips.map((p) => ({ ...p, run_id: runId, month })));
  await audit(actor, existing ? 'recalculate' : 'create', 'payroll_run', runId, null, { month, employees: slips.length });
  return getRun(runId);
}

function sumTotals(slips) {
  const sum = (k) => slips.reduce((a, p) => a + p[k], 0);
  return { employees: slips.length, total_gross: sum('gross'), total_earned: sum('earned_gross'), total_deductions: sum('deductions'), total_tax: sum('tax'), total_net: sum('net') };
}

async function listRuns() {
  const runs = await M.L(M.PayrollRun.find().sort({ month: -1 }));
  const slips = await M.Payslip.find().select('run_id gross net').lean();
  return runs.map((r) => {
    const mine = slips.filter((p) => p.run_id === r.id);
    return { ...r, employees: mine.length, total_net: mine.reduce((a, p) => a + p.net, 0), total_gross: mine.reduce((a, p) => a + p.gross, 0) };
  });
}

async function getRun(id) {
  const run = await M.L(M.PayrollRun.findById(id));
  if (!run) throw notFound('Payroll run not found');
  const slips = await withEmployee(await M.L(M.Payslip.find({ run_id: id })));
  const depts = await nameMap(M.Department, slips.map((p) => p.department_id));
  const rows = slips.map((p) => ({ ...p, department: depts.get(p.department_id) || null })).sort((a, b) => (a.employee_name || '').localeCompare(b.employee_name || ''));
  return { ...run, totals: sumTotals(slips), payslips: rows };
}

async function finalize(actor, id) {
  const run = await M.L(M.PayrollRun.findById(id));
  if (!run) throw notFound('Payroll run not found');
  if (run.status === 'finalized') throw conflict('Payroll is already finalized');
  const slips = await M.Payslip.find({ run_id: id }).select('employee_id').lean();
  if (!slips.length) throw unprocessable('Payroll draft has no payslips');
  // Atomic: only one finalize can win, and it locks the run
  const done = await M.PayrollRun.findOneAndUpdate({ _id: id, status: 'draft' }, { $set: { status: 'finalized', finalized_by: actor.id, finalized_at: new Date() } });
  if (!done) throw conflict('Payroll is already finalized');
  await audit(actor, 'finalize', 'payroll_run', id, { status: 'draft' }, { status: 'finalized', month: run.month });
  const emps = await M.Employee.find({ _id: { $in: slips.map((p) => p.employee_id) } }).select('user_id').lean();
  for (const e of emps) await notify(e.user_id, `Payslip ready: ${run.month}`, 'Your payslip is available to download.', '/payslips');
  return getRun(id);
}

// Employees only ever see finalized payslips of their own
async function listPayslips(viewer, q) {
  const filter = {};
  if (viewer.role === 'employee') filter.employee_id = viewer.employeeId;
  else if (q.employee_id) filter.employee_id = Number(q.employee_id);
  if (q.run_id) filter.run_id = Number(q.run_id);
  const runs = new Map((await M.PayrollRun.find().lean()).map((r) => [r._id, r]));
  let rows = await withEmployee(await M.L(M.Payslip.find(filter).sort({ month: -1 }).limit(500)), { dept: false });
  rows = rows.map((p) => ({ ...p, run_status: runs.get(p.run_id)?.status }));
  if (viewer.role === 'employee') rows = rows.filter((p) => p.run_status === 'finalized');
  return rows.sort((a, b) => b.month.localeCompare(a.month) || (a.employee_name || '').localeCompare(b.employee_name || ''));
}

async function getPayslip(viewer, id) {
  const p = await M.L(M.Payslip.findById(id));
  if (!p) throw notFound('Payslip not found');
  const run = await M.PayrollRun.findById(p.run_id).lean();
  if (viewer.role === 'employee' && (p.employee_id !== viewer.employeeId || run.status !== 'finalized')) throw forbidden('You can only view your own finalized payslips');
  const e = await M.Employee.findById(p.employee_id).lean();
  const dept = e.department_id ? await M.Department.findById(e.department_id).lean() : null;
  const desig = e.designation_id ? await M.Designation.findById(e.designation_id).lean() : null;
  const s = await M.Settings.findById(1).lean();
  return {
    ...p, month: run.month, run_status: run.status, employee_name: `${e.first_name} ${e.last_name}`.trim(), employee_code: e.code,
    email: e.email, join_date: e.join_date, department: dept?.name || null, designation: desig?.name || null, company_name: s.company_name,
  };
}

module.exports = { annualTax, computeSlip, generate, listRuns, getRun, finalize, listPayslips, getPayslip };

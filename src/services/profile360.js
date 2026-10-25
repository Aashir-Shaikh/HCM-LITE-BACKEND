const M = require('../db/models');
const settingsSvc = require('./settings');
const empSvc = require('./employees');
const leaveSvc = require('./leave');
const { buildCalendar } = require('./daystatus');
const { nowIn, monthRange } = require('../utils/dates');

// Employee 360: profile + this month's attendance + leave balance/history + payslips
async function build(viewer, id) {
  const profile = await empSvc.getOne(viewer, id);
  const s = await settingsSvc.get();
  const now = nowIn(s.timezone);
  const month = now.date.slice(0, 7);
  const { from, to } = monthRange(month);
  const days = await buildCalendar(id, from, to, s);
  const counts = {};
  for (const d of days) counts[d.status] = (counts[d.status] || 0) + 1;
  counts.late = days.filter((d) => d.is_late).length;
  const leaves = await leaveSvc.list({ role: 'hr', employeeId: null }, { employee_id: id });

  const runs = await M.L(M.PayrollRun.find());
  const runById = new Map(runs.map((r) => [r.id, r]));
  let slips = await M.L(M.Payslip.find({ employee_id: id }).sort({ month: -1 }).limit(12));
  slips = slips.map((p) => ({ id: p.id, month: p.month, status: runById.get(p.run_id)?.status, gross: p.gross, net: p.net }));
  if (viewer.role === 'employee') slips = slips.filter((p) => p.status === 'finalized');

  return {
    profile,
    attendance: { month, summary: counts, days },
    leave: { balances: await leaveSvc.balance(id, Number(now.date.slice(0, 4))), history: leaves.slice(0, 20) },
    payslips: slips,
  };
}

module.exports = { build };

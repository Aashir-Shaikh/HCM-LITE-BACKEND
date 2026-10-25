const router = require('express').Router();
const { requireRole, requireEmployeeRecord } = require('../middleware/auth');
const svc = require('../services/leave');
const settingsSvc = require('../services/settings');
const { nowIn } = require('../utils/dates');
const { wrap, forbidden } = require('../utils/errors');
const { parse, z, isoDate, id } = require('../utils/validate');

router.get('/leave/balance', wrap(async (req, res) => {
  const q = parse(z.object({ employee_id: id.optional(), year: z.coerce.number().int().min(2000).max(2100).optional() }), req.query);
  let eid = q.employee_id;
  if (req.user.role === 'employee' || !eid) eid = req.user.employeeId;
  if (!eid) throw forbidden('Select an employee');
  const year = q.year || Number(nowIn((await settingsSvc.get()).timezone).date.slice(0, 4));
  res.json({ employee_id: eid, year, balances: await svc.balance(eid, year) });
}));

router.get('/leave/preview', wrap(async (req, res) => {
  const q = parse(z.object({ start_date: isoDate, end_date: isoDate }), req.query);
  const days = q.end_date < q.start_date ? [] : await svc.countWorkingDays(q.start_date, q.end_date);
  res.json({ working_days: days.length, dates: days });
}));

router.get('/leave', wrap(async (req, res) => res.json(await svc.list(req.user, req.query))));

router.post('/leave', requireEmployeeRecord, wrap(async (req, res) => {
  const p = parse(z.object({
    leave_type_id: z.number().int().positive(), start_date: isoDate, end_date: isoDate,
    reason: z.string().trim().max(500).optional(),
  }), req.body);
  res.status(201).json(await svc.apply(req.user, p));
}));

router.post('/leave/:id/cancel', requireEmployeeRecord, wrap(async (req, res) => res.json(await svc.cancel(req.user, parse(id, req.params.id)))));

const review = (approve) => wrap(async (req, res) => {
  const { comment } = parse(z.object({ comment: z.string().trim().max(500).optional() }), req.body);
  res.json(await svc.review(req.user, parse(id, req.params.id), approve, comment));
});
// HR reviews employees; Admin reviews HR (enforced in the service)
router.post('/leave/:id/approve', requireRole('hr', 'admin'), review(true));
router.post('/leave/:id/reject', requireRole('hr', 'admin'), review(false));

module.exports = router;

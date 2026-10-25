const router = require('express').Router();
const { requireRole, requireEmployeeRecord } = require('../middleware/auth');
const svc = require('../services/attendance');
const settingsSvc = require('../services/settings');
const { nowIn } = require('../utils/dates');
const { wrap, forbidden } = require('../utils/errors');
const { parse, z, isoDate, month, hhmm, id } = require('../utils/validate');

router.get('/attendance/today', requireEmployeeRecord, wrap(async (req, res) => res.json(await svc.today(req.user.employeeId))));

router.post('/attendance/check-in', requireEmployeeRecord, wrap(async (req, res) => {
  const p = parse(z.object({
    source: z.enum(['web', 'camera']).default('web'),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    accuracy: z.number().min(0).nullable().optional(),
    face_count: z.number().int().min(0).optional().default(0),
  }), req.body);
  res.status(201).json(await svc.checkIn(req.user, p));
}));

router.post('/attendance/check-out', requireEmployeeRecord, wrap(async (req, res) => res.json(await svc.checkOut(req.user))));

router.get('/attendance/calendar', wrap(async (req, res) => {
  const q = parse(z.object({ month: month.optional(), employee_id: id.optional() }), req.query);
  let employeeId = q.employee_id;
  if (req.user.role === 'employee' || !employeeId) employeeId = req.user.employeeId;
  if (!employeeId) throw forbidden('Select an employee');
  const m = q.month || nowIn((await settingsSvc.get()).timezone).date.slice(0, 7);
  res.json(await svc.calendar(req.user, employeeId, m));
}));

router.get('/attendance/board', requireRole('admin', 'hr'), wrap(async (req, res) => {
  const q = parse(z.object({ date: isoDate.optional(), department_id: id.optional() }), req.query);
  const date = q.date || nowIn((await settingsSvc.get()).timezone).date;
  res.json(await svc.board(date, q.department_id));
}));

router.post('/attendance/corrections', requireEmployeeRecord, wrap(async (req, res) => {
  const p = parse(z.object({
    date: isoDate, check_in_time: hhmm.optional(), check_out_time: hhmm.optional(),
    reason: z.string().trim().min(5, 'please give a reason').max(500),
  }), req.body);
  res.status(201).json(await svc.requestCorrection(req.user, p));
}));

router.get('/attendance/corrections', wrap(async (req, res) => res.json(await svc.listCorrections(req.user, req.query))));

const review = (approve) => wrap(async (req, res) => {
  const { comment } = parse(z.object({ comment: z.string().trim().max(500).optional() }), req.body);
  res.json(await svc.reviewCorrection(req.user, parse(id, req.params.id), approve, comment));
});
// HR reviews employees; Admin reviews HR (enforced in the service)
router.post('/attendance/corrections/:id/approve', requireRole('hr', 'admin'), review(true));
router.post('/attendance/corrections/:id/reject', requireRole('hr', 'admin'), review(false));

module.exports = router;

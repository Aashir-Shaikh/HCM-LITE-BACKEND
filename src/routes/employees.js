const router = require('express').Router();
const { requireRole, requireEmployeeRecord } = require('../middleware/auth');
const svc = require('../services/employees');
const profile360 = require('../services/profile360');
const { wrap, forbidden } = require('../utils/errors');
const { parse, z, isoDate, id } = require('../utils/validate');

const base = {
  first_name: z.string().trim().min(1).max(60),
  last_name: z.string().trim().max(60).optional().default(''),
  email: z.string().trim().email(),
  phone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(300).optional(),
  gender: z.enum(['male', 'female', 'other', 'unspecified']).optional(),
  department_id: z.number().int().positive(),
  designation_id: z.number().int().positive().nullable().optional(),
  join_date: isoDate,
  status: z.enum(['active', 'probation']).optional(),
  basic_salary: z.number().positive('must be greater than 0'),
  code: z.string().trim().min(2).max(20).optional(),
};

router.get('/employees', wrap(async (req, res) => res.json(await svc.list(req.user, req.query))));

router.get('/employees/export', requireRole('hr'), wrap(async (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="employees.csv"');
  res.send(await svc.exportCsv());
}));

router.post('/employees/import', requireRole('hr'), wrap(async (req, res) => {
  const { csv } = parse(z.object({ csv: z.string().min(1).max(2_000_000) }), req.body);
  res.json(await svc.importCsv(req.user, csv, req.query.dry_run === 'true' || req.query.dry_run === '1'));
}));

router.post('/employees', requireRole('hr'), wrap(async (req, res) => {
  res.status(201).json(await svc.create(req.user, parse(z.object(base), req.body), 'employee'));
}));

// Admin creates an HR login (also gets an employee profile so HR can check in)
router.post('/hr-users', requireRole('admin'), wrap(async (req, res) => {
  const data = parse(z.object({ ...base, basic_salary: base.basic_salary.optional() }), req.body);
  res.status(201).json(await svc.create(req.user, data, 'hr'));
}));

router.patch('/me/profile', requireEmployeeRecord, wrap(async (req, res) => {
  const data = parse(z.object({ phone: z.string().trim().max(30), address: z.string().trim().max(300) }).partial(), req.body);
  res.json(await svc.updateSelf(req.user, data));
}));

router.get('/employees/:id', wrap(async (req, res) => res.json(await svc.getOne(req.user, parse(id, req.params.id)))));

router.get('/employees/:id/360', wrap(async (req, res) => {
  const eid = parse(id, req.params.id);
  if (req.user.role === 'employee' && req.user.employeeId !== eid) throw forbidden('You can only view your own profile');
  res.json(await profile360.build(req.user, eid));
}));

router.put('/employees/:id', requireRole('hr'), wrap(async (req, res) => {
  const data = parse(z.object({ ...base, status: z.enum(['active', 'probation', 'exited']), exit_date: isoDate.nullable() }).partial(), req.body);
  res.json(await svc.update(req.user, parse(id, req.params.id), data));
}));

router.put('/employees/:id/salary', requireRole('hr'), wrap(async (req, res) => {
  const data = parse(z.object({
    basic_salary: z.number().positive('must be greater than 0'),
    hra_pct: z.number().min(0).max(100).optional(),
    medical_pct: z.number().min(0).max(100).optional(),
  }), req.body);
  res.json(await svc.setSalary(req.user, parse(id, req.params.id), data));
}));

module.exports = router;

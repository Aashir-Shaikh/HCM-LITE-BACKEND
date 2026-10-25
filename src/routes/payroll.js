const router = require('express').Router();
const { requireRole } = require('../middleware/auth');
const svc = require('../services/payroll');
const pdf = require('../services/payslipPdf');
const { wrap } = require('../utils/errors');
const { parse, z, month, id } = require('../utils/validate');

router.get('/payroll/runs', requireRole('admin', 'hr'), wrap(async (_req, res) => res.json(await svc.listRuns())));
router.post('/payroll/runs', requireRole('hr'), wrap(async (req, res) => {
  const { month: m } = parse(z.object({ month }), req.body);
  res.status(201).json(await svc.generate(req.user, m));
}));
router.get('/payroll/runs/:id', requireRole('admin', 'hr'), wrap(async (req, res) => res.json(await svc.getRun(parse(id, req.params.id)))));
router.post('/payroll/runs/:id/finalize', requireRole('admin'), wrap(async (req, res) => res.json(await svc.finalize(req.user, parse(id, req.params.id)))));

router.get('/payslips', wrap(async (req, res) => res.json(await svc.listPayslips(req.user, req.query))));
router.get('/payslips/:id', wrap(async (req, res) => res.json(await svc.getPayslip(req.user, parse(id, req.params.id)))));
router.get('/payslips/:id/pdf', wrap(async (req, res) => {
  const p = await svc.getPayslip(req.user, parse(id, req.params.id));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="payslip-${p.employee_code}-${p.month}.pdf"`);
  pdf.render(p, res);
}));

module.exports = router;

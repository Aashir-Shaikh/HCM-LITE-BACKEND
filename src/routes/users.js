const router = require('express').Router();
const { requireRole } = require('../middleware/auth');
const svc = require('../services/users');
const { wrap } = require('../utils/errors');
const { parse, id } = require('../utils/validate');

router.get('/users', requireRole('admin'), wrap(async (req, res) => res.json(await svc.list(req.query))));
router.post('/users/:id/deactivate', requireRole('admin'), wrap(async (req, res) => res.json(await svc.setActive(req.user, parse(id, req.params.id), false))));
router.post('/users/:id/activate', requireRole('admin'), wrap(async (req, res) => res.json(await svc.setActive(req.user, parse(id, req.params.id), true))));
router.post('/users/:id/reset-password', requireRole('admin'), wrap(async (req, res) => res.json(await svc.resetPassword(req.user, parse(id, req.params.id)))));

module.exports = router;

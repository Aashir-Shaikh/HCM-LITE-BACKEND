const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const svc = require('../services/auth');
const { sign, authenticate } = require('../middleware/auth');
const { wrap } = require('../utils/errors');
const { parse, z } = require('../utils/validate');

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false, message: { error: { message: 'Too many attempts, try again later' } } });

router.get('/setup/status', wrap(async (_req, res) => res.json(await svc.setupStatus())));

router.post('/setup', loginLimiter, wrap(async (req, res) => {
  const body = parse(z.object({
    company_name: z.string().trim().min(2).max(120),
    admin_name: z.string().trim().min(2).max(120),
    email: z.string().trim().email(),
    password: z.string().min(8).max(128),
  }), req.body);
  const user = await svc.runSetup(body);
  res.status(201).json({ token: sign(user), user: await svc.me(user.id) });
}));

router.post('/auth/login', loginLimiter, wrap(async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().trim().email(), password: z.string().min(1) }), req.body);
  const u = await svc.login(email, password);
  res.json({ token: sign(u), user: await svc.me(u.id) });
}));

router.post('/auth/logout', (_req, res) => res.json({ ok: true })); // stateless JWT: client discards token

router.get('/auth/me', authenticate, wrap(async (req, res) => res.json(await svc.me(req.user.id))));

router.post('/auth/change-password', authenticate, wrap(async (req, res) => {
  const { current_password, new_password } = parse(z.object({ current_password: z.string().min(1), new_password: z.string().min(8).max(128) }), req.body);
  await svc.changePassword(req.user.id, current_password, new_password);
  res.json({ ok: true });
}));

module.exports = router;

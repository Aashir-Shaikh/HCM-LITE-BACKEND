const router = require('express').Router();
const { requireRole } = require('../middleware/auth');
const org = require('../services/org');
const settingsSvc = require('../services/settings');
const { wrap } = require('../utils/errors');
const { parse, z, isoDate, id, hhmm } = require('../utils/validate');
const { audit } = require('../services/audit');

const name = z.string().trim().min(1).max(100);
const schemas = {
  departments: { create: z.object({ name }), update: z.object({ name }).partial() },
  designations: { create: z.object({ name }), update: z.object({ name }).partial() },
  'leave-types': {
    create: z.object({
      code: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{2,30}$/, 'letters/numbers only'),
      name,
      yearly_quota: z.number().int().min(0).max(366).nullable().optional().default(null),
      paid: z.boolean().default(true),
    }),
    update: z.object({ name, yearly_quota: z.number().int().min(0).max(366).nullable(), paid: z.boolean() }).partial(),
  },
  holidays: { create: z.object({ date: isoDate, name }), update: z.object({ date: isoDate, name }).partial() },
};

// Everyone signed in can read lookups; only Admin can change them.
for (const key of Object.keys(schemas)) {
  const svc = org.make(key);
  router.get('/' + key, wrap(async (_req, res) => res.json(await svc.list())));
  router.post('/' + key, requireRole('admin'), wrap(async (req, res) => {
    res.status(201).json(await svc.create(req.user, parse(schemas[key].create, req.body)));
  }));
  router.put('/' + key + '/:id', requireRole('admin'), wrap(async (req, res) => {
    res.json(await svc.update(req.user, parse(id, req.params.id), parse(schemas[key].update, req.body)));
  }));
  router.delete('/' + key + '/:id', requireRole('admin'), wrap(async (req, res) => {
    await svc.remove(req.user, parse(id, req.params.id));
    res.json({ ok: true });
  }));
}

// Company settings: Admin manage, HR view
router.get('/settings', requireRole('admin', 'hr'), wrap(async (_req, res) => {
  const { lateAfterSecs, ...s } = await settingsSvc.get();
  res.json(s);
}));

router.put('/settings', requireRole('admin'), wrap(async (req, res) => {
  const body = parse(z.object({
    company_name: z.string().trim().min(2).max(120),
    timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'unknown timezone'),
    office_start: hhmm,
    grace_minutes: z.number().int().min(0).max(120),
    half_day_hours: z.number().min(1).max(12),
    weekend_days: z.array(z.number().int().min(0).max(6)).max(6),
    office_lat: z.number().min(-90).max(90).nullable(),
    office_lng: z.number().min(-180).max(180).nullable(),
    radius_m: z.number().int().min(10).max(5000),
  }).partial(), req.body);
  const before = await settingsSvc.get();
  if (Object.keys(body).length) await settingsSvc.update(body);
  const { lateAfterSecs, ...after } = await settingsSvc.get();
  const { lateAfterSecs: _l, ...b } = before;
  await audit(req.user, 'update', 'settings', 1, b, after);
  res.json(after);
}));

module.exports = router;

// Dashboards, AI, announcements, notifications, audit log
const router = require('express').Router();
const { requireRole } = require('../middleware/auth');
const analytics = require('../services/analytics');
const ai = require('../services/ai');
const comms = require('../services/comms');
const { wrap } = require('../utils/errors');
const { parse, z, id, isoDate } = require('../utils/validate');

const filters = z.object({ from: isoDate.optional(), to: isoDate.optional(), department_id: id.optional() });

router.get('/dashboard/admin', requireRole('admin'), wrap(async (req, res) => res.json(await analytics.adminDashboard(req.user, parse(filters, req.query)))));
router.get('/dashboard/hr', requireRole('hr', 'admin'), wrap(async (req, res) => res.json(await analytics.hrDashboard(req.user, parse(filters, req.query)))));
router.get('/dashboard/employee', wrap(async (req, res) => {
  if (!req.user.employeeId) return res.status(403).json({ error: { message: 'No employee profile' } });
  res.json(await analytics.employeeDashboard(req.user));
}));

// ---- AI ----
router.post('/ai/chat', wrap(async (req, res) => {
  const { messages } = parse(z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).min(1).max(40) }), req.body);
  res.json(await ai.chat(req.user, messages));
}));
router.post('/ai/summary', requireRole('admin', 'hr'), wrap(async (req, res) => res.json(await ai.summarize(req.user, parse(filters, req.body)))));
router.post('/ai/smart-leave', wrap(async (req, res) => {
  const { text } = parse(z.object({ text: z.string().trim().min(3).max(500) }), req.body);
  if (!req.user.employeeId) return res.status(403).json({ error: { message: 'No employee profile' } });
  res.json(await ai.smartLeave(req.user, text));
}));

// ---- announcements ----
router.get('/announcements', wrap(async (_req, res) => res.json(await comms.listAnnouncements())));
router.post('/announcements', requireRole('admin', 'hr'), wrap(async (req, res) => {
  const p = parse(z.object({ title: z.string().trim().min(2).max(150), body: z.string().trim().min(2).max(2000) }), req.body);
  res.status(201).json(await comms.postAnnouncement(req.user, p));
}));
router.delete('/announcements/:id', requireRole('admin', 'hr'), wrap(async (req, res) => {
  await comms.deleteAnnouncement(req.user, parse(id, req.params.id));
  res.json({ ok: true });
}));

// ---- notifications ----
router.get('/notifications', wrap(async (req, res) => {
  res.json({ unread: await comms.unreadCount(req.user.id), items: await comms.listNotifications(req.user.id) });
}));
router.post('/notifications/read-all', wrap(async (req, res) => { await comms.markAllRead(req.user.id); res.json({ ok: true }); }));
router.post('/notifications/:id/read', wrap(async (req, res) => { await comms.markRead(req.user.id, parse(id, req.params.id)); res.json({ ok: true }); }));

// ---- audit log (Admin only, read-only) ----
router.get('/audit-logs', requireRole('admin'), wrap(async (req, res) => res.json(await comms.listAudit(req.query))));

module.exports = router;

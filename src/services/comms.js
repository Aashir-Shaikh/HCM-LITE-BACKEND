const M = require('../db/models');
const { notFound } = require('../utils/errors');
const { audit } = require('./audit');
const { notify } = require('./notify');
const { nameMap } = require('./lookup');

async function listAnnouncements() {
  const rows = await M.L(M.Announcement.find().sort({ _id: -1 }).limit(50));
  const authors = await nameMap(M.User, rows.map((r) => r.author_user_id));
  return rows.map((r) => ({ ...r, author: authors.get(r.author_user_id) || null }));
}

async function postAnnouncement(actor, p) {
  const row = await M.create(M.Announcement, { title: p.title, body: p.body, author_user_id: actor.id });
  await audit(actor, 'create', 'announcement', row.id, null, row);
  const users = await M.User.find({ active: true, _id: { $ne: actor.id } }).select('_id').lean();
  for (const u of users) await notify(u._id, `Announcement: ${p.title}`, p.body.slice(0, 140), '/');
  return row;
}

async function deleteAnnouncement(actor, id) {
  const before = await M.L(M.Announcement.findById(id));
  if (!before) throw notFound('Announcement not found');
  await M.Announcement.deleteOne({ _id: id });
  await audit(actor, 'delete', 'announcement', id, before, null);
}

const listNotifications = (userId) => M.L(M.Notification.find({ user_id: userId }).sort({ _id: -1 }).limit(50));
const unreadCount = (userId) => M.Notification.countDocuments({ user_id: userId, read: false });
const markRead = (userId, id) => M.Notification.updateOne({ user_id: userId, _id: id }, { $set: { read: true } });
const markAllRead = (userId) => M.Notification.updateMany({ user_id: userId }, { $set: { read: true } });

async function listAudit(q) {
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
  const filter = {};
  if (q.entity) filter.entity = String(q.entity);
  if (q.action) filter.action = String(q.action);
  if (q.actor) filter.actor_email = new RegExp(M.escRe(String(q.actor)), 'i');
  const total = await M.AuditLog.countDocuments(filter);
  const rows = await M.L(M.AuditLog.find(filter).sort({ _id: -1 }).skip((page - 1) * limit).limit(limit));
  return { data: rows, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

module.exports = { listAnnouncements, postAnnouncement, deleteAnnouncement, listNotifications, unreadCount, markRead, markAllRead, listAudit };

const M = require('../db/models');

async function notify(userId, title, body = '', link = null) {
  if (!userId) return;
  await M.create(M.Notification, { user_id: userId, title, body, link });
}

async function notifyRoles(roles, title, body = '', link = null) {
  const users = await M.User.find({ role: { $in: roles }, active: true }).select('_id').lean();
  for (const u of users) await notify(u._id, title, body, link);
}

module.exports = { notify, notifyRoles };

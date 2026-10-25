const M = require('../db/models');

// Write an audit entry. `actor` is req.user (or null for system actions).
async function audit(actor, action, entity, entityId, before, after) {
  await M.create(M.AuditLog, {
    actor_user_id: actor ? actor.id : null,
    actor_email: actor ? actor.email : 'system',
    action,
    entity,
    entity_id: entityId == null ? null : String(entityId),
    before: before == null ? null : JSON.parse(JSON.stringify(before)),
    after: after == null ? null : JSON.parse(JSON.stringify(after)),
  });
}

module.exports = { audit };

// Generic CRUD for org setup lookups: departments, designations, leave types, holidays.
const M = require('../db/models');
const { notFound, conflict } = require('../utils/errors');
const { audit } = require('./audit');

const defs = {
  departments: { Model: M.Department, entity: 'department', sort: { name: 1 }, fk: [[M.Employee, 'department_id']] },
  designations: { Model: M.Designation, entity: 'designation', sort: { name: 1 }, fk: [[M.Employee, 'designation_id']] },
  'leave-types': { Model: M.LeaveType, entity: 'leave_type', sort: { _id: 1 }, fk: [[M.LeaveRequest, 'leave_type_id']] },
  holidays: { Model: M.Holiday, entity: 'holiday', sort: { date: 1 }, fk: [] },
};

function make(key) {
  const d = defs[key];
  return {
    list: () => M.L(d.Model.find().sort(d.sort)),
    async create(actor, data) {
      const row = await M.create(d.Model, data);
      await audit(actor, 'create', d.entity, row.id, null, row);
      return row;
    },
    async update(actor, id, data) {
      const before = await M.L(d.Model.findById(id));
      if (!before) throw notFound(d.entity + ' not found');
      if (!Object.keys(data).length) return before;
      await d.Model.updateOne({ _id: id }, { $set: data }, { runValidators: true });
      const row = await M.L(d.Model.findById(id));
      await audit(actor, 'update', d.entity, id, before, row);
      return row;
    },
    async remove(actor, id) {
      const before = await M.L(d.Model.findById(id));
      if (!before) throw notFound(d.entity + ' not found');
      for (const [Model, col] of d.fk) {
        if (await Model.exists({ [col]: id })) throw conflict(`Cannot delete: ${d.entity} is in use`);
      }
      await d.Model.deleteOne({ _id: id });
      await audit(actor, 'delete', d.entity, id, before, null);
    },
  };
}

module.exports = { make };

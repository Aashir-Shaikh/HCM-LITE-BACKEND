// Small helpers to attach names to rows (the Mongo equivalent of the SQL joins).
const M = require('../db/models');

const uniq = (a) => [...new Set(a.filter((x) => x != null))];

async function nameMap(Model, ids, field = 'name') {
  const list = uniq(ids);
  if (!list.length) return new Map();
  const rows = await Model.find({ _id: { $in: list } }).lean();
  return new Map(rows.map((r) => [r._id, field === 'full' ? `${r.first_name} ${r.last_name}`.trim() : r[field]]));
}

// Adds employee_name / employee_code / department / employee_role to rows that have employee_id
async function withEmployee(rows, { dept = true } = {}) {
  const emps = await M.Employee.find({ _id: { $in: uniq(rows.map((r) => r.employee_id)) } }).lean();
  const byId = new Map(emps.map((e) => [e._id, e]));
  const depts = dept ? await nameMap(M.Department, emps.map((e) => e.department_id)) : new Map();
  return rows.map((r) => {
    const e = byId.get(r.employee_id);
    return {
      ...r,
      employee_name: e ? `${e.first_name} ${e.last_name}`.trim() : null,
      employee_code: e ? e.code : null,
      employee_role: e ? e.role : null,
      department: e ? depts.get(e.department_id) || null : null,
    };
  });
}

module.exports = { nameMap, withEmployee, uniq };

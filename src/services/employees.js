const M = require('../db/models');
const pw = require('../utils/password');
const { parse } = require('csv-parse/sync');
const { bad, notFound, forbidden, conflict, unprocessable } = require('../utils/errors');
const { audit } = require('./audit');
const { notify } = require('./notify');
const { nameMap } = require('./lookup');

// Adds department / designation names and the login's active flag (the SQL joins)
async function decorate(rows) {
  const [depts, desigs, users] = await Promise.all([
    nameMap(M.Department, rows.map((r) => r.department_id)),
    nameMap(M.Designation, rows.map((r) => r.designation_id)),
    M.User.find({ _id: { $in: rows.map((r) => r.user_id).filter(Boolean) } }).select('active').lean(),
  ]);
  const active = new Map(users.map((u) => [u._id, u.active]));
  return rows.map((r) => ({ ...r, department: depts.get(r.department_id) || null, designation: desigs.get(r.designation_id) || null, login_active: active.get(r.user_id) }));
}

// Salary is only visible to Admin/HR or to the employee themself
function shape(row, viewer) {
  if (!row) return row;
  const canSee = viewer.role !== 'employee' || viewer.employeeId === row.id;
  if (canSee) return row;
  const { basic_salary, hra_pct, medical_pct, ...rest } = row;
  return rest;
}

async function nextCode() {
  const last = await M.Employee.findOne().sort({ _id: -1 }).select('_id').lean();
  return 'EMP-' + String((last ? last._id : 0) + 1).padStart(4, '0');
}

async function list(viewer, q) {
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
  const filter = {};
  if (viewer.role === 'employee') filter._id = viewer.employeeId;
  if (q.search) {
    const re = M.escRe(String(q.search).trim());
    filter.$or = [
      { $expr: { $regexMatch: { input: { $concat: ['$first_name', ' ', '$last_name'] }, regex: re, options: 'i' } } },
      { email: new RegExp(re, 'i') },
      { code: new RegExp(re, 'i') },
    ];
  }
  if (q.department_id) filter.department_id = Number(q.department_id);
  if (q.designation_id) filter.designation_id = Number(q.designation_id);
  if (q.status) filter.status = String(q.status);
  if (q.role) filter.role = String(q.role);

  const total = await M.Employee.countDocuments(filter);
  const rows = await M.L(M.Employee.find(filter).sort({ _id: -1 }).skip((page - 1) * limit).limit(limit));
  const data = (await decorate(rows)).map((r) => shape(r, viewer));
  return { data, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

async function getOne(viewer, id) {
  if (viewer.role === 'employee' && viewer.employeeId !== id) throw forbidden('You can only view your own profile');
  const row = await M.L(M.Employee.findById(id));
  if (!row) throw notFound('Employee not found');
  return shape((await decorate([row]))[0], viewer);
}

async function assertRefs(data) {
  if (data.department_id != null && !(await M.Department.exists({ _id: data.department_id }))) throw unprocessable('Unknown department');
  if (data.designation_id != null && !(await M.Designation.exists({ _id: data.designation_id }))) throw unprocessable('Unknown designation');
}

// Creates the employee row + login (temporary password). `role` is 'employee' (HR registers) or 'hr' (Admin creates).
async function create(actor, data, role = 'employee') {
  const email = data.email.toLowerCase();
  await assertRefs(data);
  if (await M.User.exists({ email })) throw conflict('Email already in use');
  if (data.code && (await M.Employee.exists({ code: data.code }))) throw conflict('Employee code already in use');
  const temp = pw.tempPassword();
  const fullName = `${data.first_name} ${data.last_name || ''}`.trim();
  const user = await M.create(M.User, { email, password_hash: await pw.hash(temp), role, name: fullName, must_change_password: true });
  let emp;
  try {
    emp = await M.create(M.Employee, {
      user_id: user.id, role, code: data.code || (await nextCode()), first_name: data.first_name, last_name: data.last_name || '', email,
      phone: data.phone || '', address: data.address || '', gender: data.gender || 'unspecified',
      department_id: data.department_id ?? null, designation_id: data.designation_id ?? null,
      join_date: data.join_date, status: data.status || 'active', basic_salary: data.basic_salary ?? 0,
    });
  } catch (e) {
    await M.User.deleteOne({ _id: user.id }); // no orphan login if the employee insert fails
    throw e;
  }
  await audit(actor, 'create', 'employee', emp.id, null, { ...emp, login_role: role });
  return { employee: await getOne(actor, emp.id), temporary_password: temp };
}

const EDITABLE = ['first_name', 'last_name', 'phone', 'address', 'gender', 'department_id', 'designation_id', 'join_date', 'exit_date', 'status', 'email', 'code'];

async function update(actor, id, data) {
  const before = await M.L(M.Employee.findById(id));
  if (!before) throw notFound('Employee not found');
  if (actor.role === 'hr' && actor.employeeId === id && (data.status || data.exit_date !== undefined || data.department_id)) {
    throw forbidden('You cannot change your own role-related details');
  }
  if (data.status === 'exited' && !data.exit_date && !before.exit_date) throw unprocessable('exit_date is required when status is exited');
  await assertRefs(data);
  const set = {};
  for (const f of Object.keys(data)) if (EDITABLE.includes(f)) set[f] = f === 'email' ? data[f].toLowerCase() : data[f];
  if (Object.keys(set).length) {
    set.updated_at = new Date();
    await M.Employee.updateOne({ _id: id }, { $set: set }, { runValidators: true });
    const after = await M.L(M.Employee.findById(id));
    if (before.user_id) {
      const uSet = { name: `${after.first_name} ${after.last_name}`.trim(), email: after.email };
      // exited employees can no longer sign in
      if (data.status === 'exited') uSet.active = false;
      else if (data.status && before.status === 'exited') uSet.active = true;
      await M.User.updateOne({ _id: before.user_id }, { $set: uSet });
    }
    await audit(actor, 'update', 'employee', id, before, after);
  }
  return getOne(actor, id);
}

// Employee edits own phone/address
async function updateSelf(actor, data) {
  const before = await M.L(M.Employee.findById(actor.employeeId));
  if (!before) throw notFound('Employee profile not found');
  const set = {};
  for (const f of ['phone', 'address']) if (data[f] !== undefined) set[f] = data[f];
  if (Object.keys(set).length) {
    await M.Employee.updateOne({ _id: actor.employeeId }, { $set: { ...set, updated_at: new Date() } });
    await audit(actor, 'update', 'employee', actor.employeeId, { phone: before.phone, address: before.address }, { ...{ phone: before.phone, address: before.address }, ...set });
  }
  return getOne(actor, actor.employeeId);
}

async function setSalary(actor, id, data) {
  if (actor.employeeId === id) throw forbidden('You cannot edit your own salary');
  const before = await M.L(M.Employee.findById(id).select('basic_salary hra_pct medical_pct user_id'));
  if (!before) throw notFound('Employee not found');
  const after = { basic_salary: data.basic_salary, hra_pct: data.hra_pct ?? before.hra_pct, medical_pct: data.medical_pct ?? before.medical_pct };
  await M.Employee.updateOne({ _id: id }, { $set: { ...after, updated_at: new Date() } });
  await audit(actor, 'update', 'salary_structure', id, { id, basic_salary: before.basic_salary, hra_pct: before.hra_pct, medical_pct: before.medical_pct }, after);
  await notify(before.user_id, 'Salary structure updated', 'Your salary structure was updated by HR.');
  return getOne(actor, id);
}

// ---- CSV import / export -------------------------------------------------
const REQUIRED = ['first_name', 'email', 'department', 'join_date', 'basic_salary'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function importCsv(actor, csv, dryRun) {
  let records;
  try {
    records = parse(csv, { columns: (h) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true });
  } catch (e) {
    throw bad('Could not read CSV: ' + e.message);
  }
  if (!records.length) throw bad('CSV has no data rows');
  if (records.length > 500) throw bad('CSV is limited to 500 rows');

  const depts = new Map((await M.Department.find().lean()).map((d) => [d.name.toLowerCase(), d._id]));
  const desigs = new Map((await M.Designation.find().lean()).map((d) => [d.name.toLowerCase(), d._id]));
  const existingEmails = new Set((await M.User.find().select('email').lean()).map((r) => r.email));
  const existingCodes = new Set((await M.Employee.find().select('code').lean()).map((r) => r.code.toLowerCase()));
  const seenEmails = new Set();
  const seenCodes = new Set();
  const errors = [];
  const valid = [];

  records.forEach((r, i) => {
    const row = i + 2; // header is row 1
    const err = (field, reason) => errors.push({ row, field, reason });
    const before = errors.length;
    for (const f of REQUIRED) if (!r[f]) err(f, 'required');
    const email = (r.email || '').toLowerCase();
    if (r.email) {
      if (!EMAIL_RE.test(email)) err('email', 'invalid email');
      else if (existingEmails.has(email) || seenEmails.has(email)) err('email', 'duplicate email');
    }
    const code = (r.code || '').trim();
    if (code && (existingCodes.has(code.toLowerCase()) || seenCodes.has(code.toLowerCase()))) err('code', 'duplicate code');
    const deptId = r.department ? depts.get(r.department.toLowerCase()) : undefined;
    if (r.department && !deptId) err('department', `unknown department "${r.department}"`);
    let desigId = null;
    if (r.designation) {
      desigId = desigs.get(r.designation.toLowerCase());
      if (!desigId) err('designation', `unknown designation "${r.designation}"`);
    }
    if (r.join_date && (!/^\d{4}-\d{2}-\d{2}$/.test(r.join_date) || Number.isNaN(Date.parse(r.join_date)))) err('join_date', 'must be ISO date YYYY-MM-DD');
    const sal = Number(r.basic_salary);
    if (r.basic_salary && !(sal > 0)) err('basic_salary', 'must be a number greater than 0');
    if (email) seenEmails.add(email);
    if (code) seenCodes.add(code.toLowerCase());
    if (errors.length === before) {
      valid.push({ code: code || undefined, first_name: r.first_name, last_name: r.last_name || '', email, phone: r.phone || '', address: r.address || '', gender: r.gender || 'unspecified', department_id: deptId, designation_id: desigId, join_date: r.join_date, basic_salary: sal });
    }
  });

  const summary = { total_rows: records.length, valid_rows: valid.length, error_rows: new Set(errors.map((e) => e.row)).size, errors };
  if (dryRun) return { dry_run: true, ...summary };
  if (errors.length) throw unprocessable('CSV has errors; fix them or run a dry run to see details', summary);

  const credentials = [];
  for (const v of valid) {
    const out = await create(actor, v, 'employee');
    credentials.push({ email: v.email, temporary_password: out.temporary_password });
  }
  return { dry_run: false, ...summary, imported: valid.length, credentials };
}

async function exportCsv() {
  const rows = await decorate(await M.L(M.Employee.find().sort({ _id: 1 })));
  const cols = ['code', 'first_name', 'last_name', 'email', 'phone', 'gender', 'department', 'designation', 'join_date', 'exit_date', 'status', 'basic_salary'];
  const esc = (v) => {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

module.exports = { list, getOne, create, update, updateSelf, setSalary, importCsv, exportCsv, decorate };

// End-to-end flow against an in-memory MongoDB (mongodb-memory-server): setup -> HR -> employee -> attendance -> leave -> payroll.
process.env.MONGO_IN_MEMORY = '1';
process.env.MONGODB_URI = '';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.AI_API_KEY = ''; // defined-but-empty so backend/.env can never inject a real key into tests

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const M = require('../db/models');
const { createApp } = require('../app');
const { addDays, dow, nowIn } = require('../utils/dates');
const payroll = require('../services/payroll');

let base;
let server;
const ctx = {};

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data };
}

test.before(async () => {
  await db.connect();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

test('tax slab matches the brief', () => {
  assert.equal(payroll.annualTax(600000), 0);
  assert.equal(payroll.annualTax(1200000), 30000);
  assert.equal(payroll.annualTax(2400000), 210000);
  assert.equal(payroll.annualTax(3600000), 510000);
  assert.equal(payroll.annualTax(4000000), 510000 + 0.35 * 400000);
});

test('first-run setup creates admin once', async () => {
  assert.equal((await api('GET', '/setup/status')).data.setup_done, false);
  const r = await api('POST', '/setup', { body: { company_name: 'Acme', admin_name: 'Ada Admin', email: 'admin@acme.test', password: 'Admin1234' } });
  assert.equal(r.status, 201);
  ctx.admin = r.data.token;
  assert.equal((await api('POST', '/setup', { body: { company_name: 'Other Co', admin_name: 'Other Admin', email: 'b@acme.test', password: 'Admin1234' } })).status, 409);
});

test('auth: bad login and unauthenticated access rejected', async () => {
  assert.equal((await api('POST', '/auth/login', { body: { email: 'admin@acme.test', password: 'wrong' } })).status, 401);
  assert.equal((await api('GET', '/employees')).status, 401);
});

test('admin configures org and creates HR', async () => {
  const a = ctx.admin;
  const d = await api('POST', '/departments', { token: a, body: { name: 'Engineering' } });
  assert.equal(d.status, 201);
  ctx.dept = d.data.id;
  assert.equal((await api('POST', '/departments', { token: a, body: { name: 'Engineering' } })).status, 409);
  ctx.desig = (await api('POST', '/designations', { token: a, body: { name: 'Developer' } })).data.id;
  assert.equal((await api('GET', '/leave-types', { token: a })).data.length, 4);
  const s = await api('PUT', '/settings', { token: a, body: { office_lat: 24.86, office_lng: 67.0, radius_m: 150 } });
  assert.equal(s.status, 200);

  const hr = await api('POST', '/hr-users', { token: a, body: { first_name: 'Hina', last_name: 'HR', email: 'hr@acme.test', department_id: ctx.dept, join_date: '2025-01-01' } });
  assert.equal(hr.status, 201);
  ctx.hrTemp = hr.data.temporary_password;
  ctx.hrEmp = hr.data.employee.id;
});

test('HR must change temporary password before anything else', async () => {
  const l = await api('POST', '/auth/login', { body: { email: 'hr@acme.test', password: ctx.hrTemp } });
  assert.equal(l.status, 200);
  assert.equal(l.data.user.must_change_password, true);
  assert.equal((await api('GET', '/employees', { token: l.data.token })).status, 403);
  assert.equal((await api('POST', '/auth/change-password', { token: l.data.token, body: { current_password: ctx.hrTemp, new_password: 'HrPass1234' } })).status, 200);
  ctx.hr = (await api('POST', '/auth/login', { body: { email: 'hr@acme.test', password: 'HrPass1234' } })).data.token;
  assert.equal((await api('GET', '/employees', { token: ctx.hr })).status, 200);
});

test('RBAC: HR cannot change settings, admin cannot register employees', async () => {
  assert.equal((await api('PUT', '/settings', { token: ctx.hr, body: { radius_m: 500 } })).status, 403);
  assert.equal((await api('POST', '/employees', { token: ctx.admin, body: {} })).status, 403);
  assert.equal((await api('POST', '/hr-users', { token: ctx.hr, body: {} })).status, 403);
  assert.equal((await api('GET', '/audit-logs', { token: ctx.hr })).status, 403);
});

test('HR registers employees; validation and CSV dry run', async () => {
  const bad = await api('POST', '/employees', { token: ctx.hr, body: { first_name: 'X', email: 'nope', department_id: ctx.dept, join_date: '2025-01-01', basic_salary: 0 } });
  assert.equal(bad.status, 400);
  const mk = (n, sal) => api('POST', '/employees', { token: ctx.hr, body: { first_name: n, last_name: 'Tester', email: `${n.toLowerCase()}@acme.test`, department_id: ctx.dept, designation_id: ctx.desig, join_date: '2025-01-01', basic_salary: sal } });
  const e1 = await mk('Ali', 100000);
  const e2 = await mk('Sara', 150000);
  assert.equal(e1.status, 201);
  ctx.aliId = e1.data.employee.id;
  ctx.saraId = e2.data.employee.id;
  ctx.aliTemp = e1.data.temporary_password;
  ctx.saraTemp = e2.data.temporary_password;

  const dry = await api('POST', '/employees/import?dry_run=true', { token: ctx.hr, body: { csv: 'first_name,last_name,email,department,join_date,basic_salary\nZed,Z,ali@acme.test,Nowhere,2025-13-40,-5\nOk,Fine,ok@acme.test,Engineering,2025-02-01,50000' } });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.valid_rows, 1);
  const fields = dry.data.errors.map((e) => e.field).sort();
  assert.deepEqual(fields, ['basic_salary', 'department', 'email', 'join_date']);
  assert.ok(dry.data.errors.every((e) => e.row === 2 && e.reason));
  assert.equal((await api('POST', '/employees/import', { token: ctx.hr, body: { csv: 'first_name,email,department,join_date,basic_salary\nOk,ok@acme.test,Engineering,2025-02-01,50000' } })).data.imported, 1);
});

test('employee scope: only own rows and no colleague data', async () => {
  const l = await api('POST', '/auth/login', { body: { email: 'ali@acme.test', password: ctx.aliTemp } });
  await api('POST', '/auth/change-password', { token: l.data.token, body: { current_password: ctx.aliTemp, new_password: 'AliPass1234' } });
  ctx.ali = (await api('POST', '/auth/login', { body: { email: 'ali@acme.test', password: 'AliPass1234' } })).data.token;
  const l2 = await api('POST', '/auth/login', { body: { email: 'sara@acme.test', password: ctx.saraTemp } });
  await api('POST', '/auth/change-password', { token: l2.data.token, body: { current_password: ctx.saraTemp, new_password: 'SaraPass1234' } });
  ctx.sara = (await api('POST', '/auth/login', { body: { email: 'sara@acme.test', password: 'SaraPass1234' } })).data.token;

  const list = await api('GET', '/employees', { token: ctx.ali });
  assert.equal(list.data.total, 1);
  assert.equal((await api('GET', `/employees/${ctx.saraId}`, { token: ctx.ali })).status, 403);
  assert.equal((await api('GET', `/employees/${ctx.saraId}/360`, { token: ctx.ali })).status, 403);
  assert.equal((await api('GET', `/attendance/calendar?employee_id=${ctx.saraId}`, { token: ctx.ali })).data.employee_id, ctx.aliId);
  assert.equal((await api('PUT', `/employees/${ctx.aliId}/salary`, { token: ctx.ali, body: { basic_salary: 999999 } })).status, 403);
  assert.equal((await api('GET', '/payroll/runs', { token: ctx.ali })).status, 403);
  assert.equal((await api('PATCH', '/me/profile', { token: ctx.ali, body: { phone: '0300-1234567' } })).data.phone, '0300-1234567');
});

test('attendance: check-in, duplicate = 409, check-out, camera rules', async () => {
  const ci = await api('POST', '/attendance/check-in', { token: ctx.ali, body: {} });
  assert.equal(ci.status, 201);
  assert.ok(['present', 'late'].includes(ci.data.status));
  assert.equal((await api('POST', '/attendance/check-in', { token: ctx.ali, body: {} })).status, 409);
  const co = await api('POST', '/attendance/check-out', { token: ctx.ali });
  assert.equal(co.status, 200);
  assert.equal(co.data.status, 'half_day'); // worked far less than 5h
  assert.equal((await api('POST', '/attendance/check-out', { token: ctx.ali })).status, 409);

  // camera: no face / outside radius / inside radius
  assert.equal((await api('POST', '/attendance/check-in', { token: ctx.sara, body: { source: 'camera', face_count: 0, lat: 24.86, lng: 67.0, accuracy: 10 } })).status, 422);
  const far = await api('POST', '/attendance/check-in', { token: ctx.sara, body: { source: 'camera', face_count: 1, lat: 24.9, lng: 67.1, accuracy: 10 } });
  assert.equal(far.status, 422);
  assert.match(far.data.error.message, /from the office/);
  assert.equal((await api('POST', '/attendance/check-in', { token: ctx.sara, body: { source: 'camera', face_count: 1, lat: 24.86, lng: 67.0, accuracy: 150 } })).status, 422);
  const ok = await api('POST', '/attendance/check-in', { token: ctx.sara, body: { source: 'camera', face_count: 1, lat: 24.86, lng: 67.0, accuracy: 20 } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.source, 'camera');
});

test('leave: working days only, overlap/balance 422, HR approval', async () => {
  const s = (await api('GET', '/settings', { token: ctx.hr })).data;
  let monday = addDays(nowIn(s.timezone).date, 7);
  while (dow(monday) !== 1) monday = addDays(monday, 1);
  const types = (await api('GET', '/leave-types', { token: ctx.ali })).data;
  const casual = types.find((t) => t.code === 'casual');
  const sick = types.find((t) => t.code === 'sick');

  const prev = await api('GET', `/leave/preview?start_date=${monday}&end_date=${addDays(monday, 6)}`, { token: ctx.ali });
  assert.equal(prev.data.working_days, 5);

  const apply = await api('POST', '/leave', { token: ctx.ali, body: { leave_type_id: casual.id, start_date: monday, end_date: addDays(monday, 1), reason: 'wedding' } });
  assert.equal(apply.status, 201);
  assert.equal(apply.data.days, 2);
  ctx.leaveId = apply.data.id;
  assert.equal((await api('POST', '/leave', { token: ctx.ali, body: { leave_type_id: sick.id, start_date: addDays(monday, 1), end_date: addDays(monday, 2) } })).status, 422); // overlap
  assert.equal((await api('POST', '/leave', { token: ctx.ali, body: { leave_type_id: sick.id, start_date: addDays(monday, 14), end_date: addDays(monday, 25) } })).status, 422); // > sick balance (8)
  assert.equal((await api('POST', `/leave/${ctx.leaveId}/approve`, { token: ctx.sara, body: {} })).status, 403);
  assert.equal((await api('POST', `/leave/${ctx.leaveId}/approve`, { token: ctx.hr, body: { comment: 'enjoy' } })).status, 200);
  assert.equal((await api('POST', `/leave/${ctx.leaveId}/approve`, { token: ctx.hr, body: {} })).status, 409);
  const bal = (await api('GET', '/leave/balance', { token: ctx.ali })).data.balances.find((b) => b.code === 'casual');
  assert.equal(bal.used, 2);
  assert.equal(bal.remaining, 8);
  const notes = await api('GET', '/notifications', { token: ctx.ali });
  assert.ok(notes.data.items.some((n) => /approved/i.test(n.title)));
});

test('payroll: HR drafts, only Admin finalizes, finalized is locked, payslip PDF scoped', async () => {
  const s = (await api('GET', '/settings', { token: ctx.hr })).data;
  const month = nowIn(s.timezone).date.slice(0, 7);
  const run = await api('POST', '/payroll/runs', { token: ctx.hr, body: { month } });
  assert.equal(run.status, 201);
  const ali = run.data.payslips.find((p) => p.employee_id === ctx.aliId);
  assert.equal(ali.gross, 150000); // 1.5 x basic
  assert.equal(ali.hra, 40000);
  assert.equal(ali.medical, 10000);
  assert.ok(ali.net <= ali.earned_gross);
  assert.equal((await api('POST', `/payroll/runs/${run.data.id}/finalize`, { token: ctx.hr })).status, 403);
  assert.equal((await api('GET', '/payslips', { token: ctx.ali })).data.length, 0); // draft hidden from employees
  assert.equal((await api('POST', `/payroll/runs/${run.data.id}/finalize`, { token: ctx.admin })).status, 200);
  assert.equal((await api('POST', '/payroll/runs', { token: ctx.hr, body: { month } })).status, 409);

  const mine = await api('GET', '/payslips', { token: ctx.ali });
  assert.equal(mine.data.length, 1);
  const pdf = await api('GET', `/payslips/${mine.data[0].id}/pdf`, { token: ctx.ali });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');
  const saraSlip = (await api('GET', '/payslips', { token: ctx.hr })).data.find((p) => p.employee_id === ctx.saraId);
  assert.equal((await api('GET', `/payslips/${saraSlip.id}`, { token: ctx.ali })).status, 403);
});

test('dashboards, audit log and AI guard rails', async () => {
  const hr = await api('GET', '/dashboard/hr', { token: ctx.hr });
  assert.equal(hr.status, 200);
  assert.equal(hr.data.kpis.headcount, 4); // HR + Ali + Sara + Ok
  assert.equal(hr.data.kpis.present_today, 2);
  const adm = await api('GET', '/dashboard/admin', { token: ctx.admin });
  assert.equal(adm.status, 200);
  assert.ok(adm.data.kpis.payroll_cost_gross > 0);
  assert.equal((await api('GET', '/dashboard/admin', { token: ctx.hr })).status, 403);
  const emp = await api('GET', '/dashboard/employee', { token: ctx.ali });
  assert.equal(emp.status, 200);
  assert.ok(emp.data.kpis.last_payslip);

  const log = await api('GET', '/audit-logs?entity=payroll_run', { token: ctx.admin });
  assert.ok(log.data.data.some((l) => l.action === 'finalize'));
  await assert.rejects(M.AuditLog.deleteMany({}), /append-only/);
  await assert.rejects(M.AuditLog.updateMany({}, { $set: { action: 'x' } }), /append-only/);

  assert.equal((await api('POST', '/ai/chat', { token: ctx.ali, body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 503);
  assert.equal((await api('POST', '/ai/summary', { token: ctx.ali, body: {} })).status, 403);
  const ai = require('../services/ai');
  const aliUser = { id: 0, role: 'employee', employeeId: ctx.aliId, name: 'Ali' };
  assert.deepEqual(await ai.runTool(aliUser, 'search_employees', { search: 'Sara' }), { error: 'You are not allowed to use this information.' });
  assert.deepEqual(await ai.runTool(aliUser, 'get_payroll_summary', {}), { error: 'You are not allowed to use this information.' });
  const bal = await ai.runTool(aliUser, 'get_my_leave_balance', {});
  assert.equal(bal.balances.find((b) => b.code === 'casual').remaining, 8);
});

test('mongo: attendance correction recomputes status; concurrent check-ins create one record', async () => {
  const s = (await api('GET', '/settings', { token: ctx.hr })).data;
  const day = addDays(nowIn(s.timezone).date, -3);
  const r = await api('POST', '/attendance/corrections', { token: ctx.sara, body: { date: day, check_in_time: '09:05', check_out_time: '18:05', reason: 'forgot to check in' } });
  assert.equal(r.status, 201);
  assert.equal((await api('POST', `/attendance/corrections/${r.data.id}/approve`, { token: ctx.sara, body: {} })).status, 403); // no self-review
  assert.equal((await api('POST', `/attendance/corrections/${r.data.id}/approve`, { token: ctx.hr, body: {} })).status, 200);
  assert.equal((await api('POST', `/attendance/corrections/${r.data.id}/approve`, { token: ctx.hr, body: {} })).status, 409);
  const rec = await M.Attendance.findOne({ employee_id: ctx.saraId, date: day }).lean();
  assert.equal(rec.status, 'present'); // 09:05 is inside the grace time
  assert.equal(rec.worked_hours, 9);
  assert.equal(rec.source, 'correction');

  const b = await api('POST', '/auth/login', { body: { email: 'ok@acme.test', password: 'x' } });
  assert.equal(b.status, 401);
  // two parallel check-ins for the same new user: exactly one wins (unique index)
  const emp = await api('POST', '/employees', { token: ctx.hr, body: { first_name: 'Race', last_name: 'Test', email: 'race@acme.test', department_id: ctx.dept, join_date: '2025-01-01', basic_salary: 50000 } });
  const l1 = await api('POST', '/auth/login', { body: { email: 'race@acme.test', password: emp.data.temporary_password } });
  await api('POST', '/auth/change-password', { token: l1.data.token, body: { current_password: emp.data.temporary_password, new_password: 'RacePass1234' } });
  const tok = (await api('POST', '/auth/login', { body: { email: 'race@acme.test', password: 'RacePass1234' } })).data.token;
  const results = await Promise.all([1, 2, 3].map(() => api('POST', '/attendance/check-in', { token: tok, body: {} })));
  assert.deepEqual(results.map((x) => x.status).sort(), [201, 409, 409]);
  assert.equal(await M.Attendance.countDocuments({ employee_id: emp.data.employee.id }), 1);
});

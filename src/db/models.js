// MongoDB collections (Mongoose). Ids are sequential integers (via the counters collection) so the REST
// contract stays simple; calendar dates are 'YYYY-MM-DD' strings, instants are Dates.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const base = { versionKey: false };
const ts = { type: Date, default: Date.now };
const num = { type: Number, _id: false };

function model(name, def, opts = {}, setup) {
  const schema = new Schema({ _id: { type: Number }, ...def }, { ...base, ...opts });
  if (setup) setup(schema);
  return mongoose.model(name, schema);
}

const Counter = mongoose.model('Counter', new Schema({ _id: String, seq: { type: Number, default: 0 } }, base));

// Atomic auto-increment id
async function nextId(name) {
  const c = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return c.seq;
}

const Settings = model('Settings', {
  company_name: { type: String, default: '' },
  setup_done: { type: Boolean, default: false },
  timezone: { type: String, default: 'Asia/Karachi' },
  office_start: { type: String, default: '09:00' },
  grace_minutes: { type: Number, default: 15 },
  half_day_hours: { type: Number, default: 5 },
  weekend_days: { type: [Number], default: [0, 6] },
  office_lat: { type: Number, default: null },
  office_lng: { type: Number, default: null },
  radius_m: { type: Number, default: 150 },
  updated_at: ts,
}, { collection: 'settings' });

async function ensureSettings() {
  await Settings.updateOne({ _id: 1 }, { $setOnInsert: { _id: 1 } }, { upsert: true });
}

const Department = model('Department', { name: { type: String, required: true, unique: true, trim: true }, created_at: ts });
const Designation = model('Designation', { name: { type: String, required: true, unique: true, trim: true }, created_at: ts });
const LeaveType = model('LeaveType', {
  code: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  yearly_quota: { type: Number, default: null },
  paid: { type: Boolean, default: true },
  created_at: ts,
});
const Holiday = model('Holiday', { date: { type: String, required: true, unique: true }, name: { type: String, required: true } });

const User = model('User', {
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },
  role: { type: String, required: true, enum: ['admin', 'hr', 'employee'] },
  name: { type: String, default: '' },
  active: { type: Boolean, default: true },
  must_change_password: { type: Boolean, default: false },
  last_login_at: { type: Date, default: null },
  created_at: ts,
});

const Employee = model('Employee', {
  user_id: { type: Number, unique: true, sparse: true },
  role: { type: String, enum: ['hr', 'employee'], default: 'employee' }, // copy of the login role
  code: { type: String, required: true, unique: true },
  first_name: { type: String, required: true },
  last_name: { type: String, default: '' },
  email: { type: String, required: true, unique: true, lowercase: true },
  phone: { type: String, default: '' },
  address: { type: String, default: '' },
  gender: { type: String, default: 'unspecified' },
  department_id: { type: Number, default: null, index: true },
  designation_id: { type: Number, default: null },
  join_date: { type: String, required: true },
  exit_date: { type: String, default: null },
  status: { type: String, enum: ['active', 'probation', 'exited'], default: 'active' },
  basic_salary: { type: Number, default: 0 },
  hra_pct: { type: Number, default: 40 },
  medical_pct: { type: Number, default: 10 },
  created_at: ts,
  updated_at: ts,
});

const Attendance = model('Attendance', {
  employee_id: { type: Number, required: true },
  date: { type: String, required: true },
  check_in: { type: Date, default: null },
  check_out: { type: Date, default: null },
  status: { type: String, default: 'present' },
  is_late: { type: Boolean, default: false },
  worked_hours: { type: Number, default: null },
  source: { type: String, default: 'web' },
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
  accuracy: { type: Number, default: null },
  distance_m: { type: Number, default: null },
  created_at: ts,
}, { collection: 'attendance' }, (s) => {
  s.index({ employee_id: 1, date: 1 }, { unique: true }); // one record per employee per day
  s.index({ date: 1 });
});

const AttendanceCorrection = model('AttendanceCorrection', {
  employee_id: { type: Number, required: true, index: true },
  date: { type: String, required: true },
  check_in_time: { type: String, default: null },
  check_out_time: { type: String, default: null },
  reason: { type: String, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  reviewer_user_id: { type: Number, default: null },
  review_comment: { type: String, default: null },
  created_at: ts,
  reviewed_at: { type: Date, default: null },
}, { collection: 'attendance_corrections' });

const LeaveRequest = model('LeaveRequest', {
  employee_id: { type: Number, required: true, index: true },
  leave_type_id: { type: Number, required: true },
  start_date: { type: String, required: true },
  end_date: { type: String, required: true },
  days: { type: Number, required: true },
  reason: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
  reviewer_user_id: { type: Number, default: null },
  review_comment: { type: String, default: null },
  created_at: ts,
  reviewed_at: { type: Date, default: null },
}, { collection: 'leave_requests' });

const PayrollRun = model('PayrollRun', {
  month: { type: String, required: true, unique: true },
  status: { type: String, enum: ['draft', 'finalized'], default: 'draft' },
  created_by: { type: Number, default: null },
  finalized_by: { type: Number, default: null },
  created_at: ts,
  finalized_at: { type: Date, default: null },
}, { collection: 'payroll_runs' });

const Payslip = model('Payslip', {
  run_id: { type: Number, required: true },
  month: { type: String, required: true },
  employee_id: { type: Number, required: true },
  department_id: { type: Number, default: null },
  basic: Number, hra: Number, medical: Number, gross: Number,
  working_days: Number, employed_days: Number,
  absent_days: Number, unpaid_days: Number, half_days: Number,
  earned_gross: Number, deductions: Number, tax: Number, net: Number,
}, { collection: 'payslips' }, (s) => {
  s.index({ run_id: 1, employee_id: 1 }, { unique: true });
  s.index({ employee_id: 1 });
});

const Announcement = model('Announcement', {
  title: { type: String, required: true },
  body: { type: String, required: true },
  author_user_id: { type: Number, default: null },
  created_at: ts,
});

const Notification = model('Notification', {
  user_id: { type: Number, required: true },
  title: { type: String, required: true },
  body: { type: String, default: '' },
  link: { type: String, default: null },
  read: { type: Boolean, default: false },
  created_at: ts,
}, {}, (s) => s.index({ user_id: 1, read: 1 }));

// Append-only: any update/delete is rejected, so entries can never be changed
const AuditLog = model('AuditLog', {
  actor_user_id: { type: Number, default: null },
  actor_email: { type: String, default: 'system' },
  action: { type: String, required: true },
  entity: { type: String, required: true },
  entity_id: { type: String, default: null },
  before: { type: Schema.Types.Mixed, default: null },
  after: { type: Schema.Types.Mixed, default: null },
  created_at: ts,
}, { collection: 'audit_logs' }, (s) => {
  const block = function (next) { next(new Error('audit_logs is append-only')); };
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany'].forEach((op) => s.pre(op, block));
  s.pre('save', function (next) { next(this.isNew ? undefined : new Error('audit_logs is append-only')); });
});

const AiLog = model('AiLog', {
  user_id: { type: Number, default: null },
  kind: { type: String, required: true },
  prompt: String,
  response: String,
  tool_calls: { type: Schema.Types.Mixed, default: [] },
  status: { type: String, required: true },
  duration_ms: Number,
  created_at: ts,
}, { collection: 'ai_logs' }, (s) => s.index({ user_id: 1, created_at: -1 }));

const all = {
  Settings, Department, Designation, LeaveType, Holiday, User, Employee, Attendance, AttendanceCorrection,
  LeaveRequest, PayrollRun, Payslip, Announcement, Notification, AuditLog, AiLog, Counter,
};

// ---- helpers -------------------------------------------------------------
// lean doc -> API shape ({_id} -> {id})
const fix = (d) => {
  if (!d) return d;
  const { _id, ...rest } = d;
  return { id: _id, ...rest };
};
// Run a query and return plain objects with `id`
const L = async (q) => {
  const r = await q.lean();
  return Array.isArray(r) ? r.map(fix) : fix(r);
};
// Insert with auto id, returns plain object
async function create(Model, data) {
  const _id = await nextId(Model.collection.name);
  const doc = await Model.create({ _id, ...data });
  return fix(doc.toObject());
}
async function createMany(Model, rows) {
  const out = [];
  for (const r of rows) out.push(await create(Model, r));
  return out;
}
// Case-insensitive literal match
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { ...all, all, nextId, ensureSettings, fix, L, create, createMany, escRe };

const M = require('../db/models');
const settingsSvc = require('./settings');
const { buildCalendar, effStatus } = require('./daystatus');
const { withEmployee } = require('./lookup');
const { nowIn, isWeekend, monthRange, zonedToUtc } = require('../utils/dates');
const { haversine } = require('../utils/geo');
const { conflict, unprocessable, notFound, forbidden, bad } = require('../utils/errors');
const { audit } = require('./audit');
const { notify, notifyRoles } = require('./notify');

const hhmmSecs = (t) => { const [h, m] = t.split(':').map(Number); return h * 3600 + m * 60; };
const round2 = (n) => Math.round(n * 100) / 100;

const onApprovedLeave = (employeeId, date) =>
  M.LeaveRequest.exists({ employee_id: employeeId, status: 'approved', start_date: { $lte: date }, end_date: { $gte: date } });

async function today(employeeId) {
  const s = await settingsSvc.get();
  const now = nowIn(s.timezone);
  const rec = await M.L(M.Attendance.findOne({ employee_id: employeeId, date: now.date }));
  const leave = await onApprovedLeave(employeeId, now.date);
  return {
    date: now.date, record: rec, on_leave: !!leave && !rec,
    is_working_day: !isWeekend(now.date, s.weekend_days),
    office: { lat: s.office_lat, lng: s.office_lng, radius_m: s.radius_m },
  };
}

// Camera/location rules: exactly one face, GPS accuracy <= 100 m, inside the office radius.
// The server decides; the client only sends data.
function verifyCamera(s, p) {
  if (p.face_count !== 1) throw unprocessable(p.face_count > 1 ? 'More than one face detected' : 'No face detected');
  if (s.office_lat == null || s.office_lng == null) throw unprocessable('Office location is not configured by Admin yet (set in Organization setup)');
  if (p.lat == null || p.lng == null) throw unprocessable('Location is required for camera check-in');
  if (p.accuracy != null && p.accuracy > 1500) throw unprocessable(`Location accuracy is too low (${Math.round(p.accuracy)} m). Please use a device with better signal.`);
  const distance = haversine(p.lat, p.lng, s.office_lat, s.office_lng);
  if (distance > s.radius_m) throw unprocessable(`You are ${Math.round(distance)} m from the office (allowed ${s.radius_m} m)`);
  return Math.round(distance);
}

async function checkIn(actor, p) {
  const s = await settingsSvc.get();
  const now = nowIn(s.timezone);
  let distance = null;
  if (p.source === 'camera') distance = verifyCamera(s, p);
  if (await onApprovedLeave(actor.employeeId, now.date)) throw unprocessable('You are on approved leave today');

  const isLate = now.secs > s.lateAfterSecs;
  try {
    // The unique (employee_id, date) index makes a second check-in impossible even under a race
    return await M.create(M.Attendance, {
      employee_id: actor.employeeId, date: now.date, check_in: new Date(), status: isLate ? 'late' : 'present', is_late: isLate,
      source: p.source, lat: p.lat ?? null, lng: p.lng ?? null, accuracy: p.accuracy ?? null, distance_m: distance,
    });
  } catch (e) {
    if (e.code === 11000) throw conflict('You have already checked in today');
    throw e;
  }
}

function statusFor(isLate, hours, halfDayHours) {
  if (hours < halfDayHours) return 'half_day';
  return isLate ? 'late' : 'present';
}

async function checkOut(actor) {
  const s = await settingsSvc.get();
  const now = nowIn(s.timezone);
  const rec = await M.Attendance.findOne({ employee_id: actor.employeeId, date: now.date }).lean();
  if (!rec) throw unprocessable('You have not checked in today');
  if (rec.check_out) throw conflict('You have already checked out today');
  const out = new Date();
  const hours = round2((out - rec.check_in) / 3600000);
  const updated = await M.Attendance.findOneAndUpdate(
    { _id: rec._id, check_out: null },
    { $set: { check_out: out, worked_hours: hours, status: statusFor(rec.is_late, hours, s.half_day_hours) } },
    { new: true }
  ).lean();
  if (!updated) throw conflict('You have already checked out today');
  return M.fix(updated);
}

async function calendar(viewer, employeeId, month) {
  if (viewer.role === 'employee' && viewer.employeeId !== employeeId) throw forbidden('You can only view your own attendance');
  const { from, to } = monthRange(month);
  const days = await buildCalendar(employeeId, from, to);
  const summary = {};
  for (const d of days) summary[d.status] = (summary[d.status] || 0) + 1;
  summary.late = days.filter((d) => d.is_late).length;
  return { employee_id: employeeId, month, days, summary };
}

// Daily board for HR/Admin: one row per employed person for the date
async function board(date, departmentId) {
  const s = await settingsSvc.get();
  const nowD = nowIn(s.timezone).date;
  const filter = { join_date: { $lte: date }, $or: [{ exit_date: null }, { exit_date: { $gte: date } }] };
  if (departmentId) filter.department_id = departmentId;
  const emps = await M.Employee.find(filter).sort({ first_name: 1 }).lean();
  const ids = emps.map((e) => e._id);
  const recs = new Map((await M.Attendance.find({ date, employee_id: { $in: ids } }).lean()).map((a) => [a.employee_id, a]));
  const leaveIds = new Set((await M.LeaveRequest.find({ employee_id: { $in: ids }, status: 'approved', start_date: { $lte: date }, end_date: { $gte: date } }).select('employee_id').lean()).map((l) => l.employee_id));
  const depts = new Map((await M.Department.find().lean()).map((d) => [d._id, d.name]));
  const holiday = await M.Holiday.findOne({ date }).lean();
  const nonWorking = isWeekend(date, s.weekend_days) || !!holiday;

  const rows = emps.map((e) => {
    const a = recs.get(e._id);
    let status;
    if (a) status = effStatus(a, nowD);
    else if (nonWorking) status = holiday ? 'holiday' : 'weekend';
    else if (leaveIds.has(e._id)) status = 'on_leave';
    else status = date >= nowD ? 'pending' : 'absent';
    return {
      employee_id: e._id, code: e.code, name: `${e.first_name} ${e.last_name}`.trim(), department: depts.get(e.department_id) || null,
      check_in: a?.check_in ?? null, check_out: a?.check_out ?? null, is_late: a?.is_late ?? null, worked_hours: a?.worked_hours ?? null, source: a?.source ?? null,
      on_leave: leaveIds.has(e._id), status,
    };
  });
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return { date, non_working_day: nonWorking, holiday: holiday ? holiday.name : null, counts, rows };
}

// ---- corrections --------------------------------------------------------
async function requestCorrection(actor, p) {
  const s = await settingsSvc.get();
  const todayD = nowIn(s.timezone).date;
  if (p.date > todayD) throw unprocessable('Cannot request a correction for a future date');
  if (!p.check_in_time && !p.check_out_time) throw bad('Provide a check-in and/or check-out time');
  const emp = await M.Employee.findById(actor.employeeId).select('join_date').lean();
  if (p.date < emp.join_date) throw unprocessable('Date is before your join date');
  if (await M.AttendanceCorrection.exists({ employee_id: actor.employeeId, date: p.date, status: 'pending' })) throw conflict('A pending correction already exists for this date');
  const row = await M.create(M.AttendanceCorrection, {
    employee_id: actor.employeeId, date: p.date, check_in_time: p.check_in_time || null, check_out_time: p.check_out_time || null, reason: p.reason,
  });
  await audit(actor, 'create', 'attendance_correction', row.id, null, row);
  // HR reviews employees; Admin reviews HR's own requests
  await notifyRoles(actor.role === 'hr' ? ['admin'] : ['hr'], 'Attendance correction requested', `${actor.name} requested a correction for ${p.date}`, '/attendance/corrections');
  return row;
}

async function listCorrections(viewer, q) {
  const filter = {};
  if (viewer.role === 'employee') filter.employee_id = viewer.employeeId;
  if (q.status) filter.status = String(q.status);
  const rows = await M.L(M.AttendanceCorrection.find(filter).sort({ created_at: -1 }).limit(200));
  const withNames = await withEmployee(rows, { dept: false });
  return withNames.sort((a, b) => (b.status === 'pending') - (a.status === 'pending'));
}

async function applyCorrection(c, s) {
  const existing = await M.Attendance.findOne({ employee_id: c.employee_id, date: c.date }).lean();
  if (!existing && !c.check_in_time) throw unprocessable('Cannot add a check-out without a check-in');
  const tz = s.timezone;
  const checkIn = c.check_in_time ? zonedToUtc(c.date, c.check_in_time, tz) : existing.check_in;
  const checkOut = c.check_out_time ? zonedToUtc(c.date, c.check_out_time, tz) : existing ? existing.check_out : null;
  // Recompute lateness, hours and status from the corrected times
  const isLate = nowIn(tz, checkIn).secs > s.lateAfterSecs;
  let hours = null;
  let status = isLate ? 'late' : 'present';
  if (checkOut) {
    hours = round2((checkOut - checkIn) / 3600000);
    if (hours < 0) throw unprocessable('Check-out must be after check-in');
    status = statusFor(isLate, hours, s.half_day_hours);
  }
  const fields = { check_in: checkIn, check_out: checkOut, is_late: isLate, worked_hours: hours, status, source: 'correction' };
  if (existing) await M.Attendance.updateOne({ _id: existing._id }, { $set: fields });
  else await M.create(M.Attendance, { employee_id: c.employee_id, date: c.date, ...fields });
}

async function reviewCorrection(actor, id, approve, comment) {
  const c = await M.L(M.AttendanceCorrection.findById(id));
  if (!c) throw notFound('Correction not found');
  const emp = await M.Employee.findById(c.employee_id).lean();
  if (c.status !== 'pending') throw conflict(`Correction is already ${c.status}`);
  if (c.employee_id === actor.employeeId) throw forbidden('You cannot review your own correction');
  // HR reviews employees; HR's own corrections go to Admin
  if (emp.role === 'hr' && actor.role !== 'admin') throw forbidden('Only Admin can review HR corrections');
  if (emp.role !== 'hr' && actor.role !== 'hr') throw forbidden('Only HR can review employee corrections');
  const s = await settingsSvc.get();

  // Atomic claim so two reviewers can never both decide the same request
  const claimed = await M.AttendanceCorrection.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status: approve ? 'approved' : 'rejected', reviewer_user_id: actor.id, review_comment: comment || null, reviewed_at: new Date() } }
  );
  if (!claimed) throw conflict('Correction was already reviewed');
  try {
    if (approve) await applyCorrection(c, s);
  } catch (e) {
    await M.AttendanceCorrection.updateOne({ _id: id }, { $set: { status: 'pending', reviewer_user_id: null, review_comment: null, reviewed_at: null } });
    throw e;
  }
  await audit(actor, approve ? 'approve' : 'reject', 'attendance_correction', id, { status: 'pending' }, { status: approve ? 'approved' : 'rejected', comment });
  await notify(emp.user_id, `Attendance correction ${approve ? 'approved' : 'rejected'}`, `Your correction for ${c.date} was ${approve ? 'approved' : 'rejected'}${comment ? ': ' + comment : ''}`);
  return M.L(M.AttendanceCorrection.findById(id));
}

module.exports = { today, checkIn, checkOut, calendar, board, requestCorrection, listCorrections, reviewCorrection };

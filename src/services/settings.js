const M = require('../db/models');
const { hhmmToSecs } = require('../utils/dates');

async function get() {
  const s = M.fix(await M.Settings.findById(1).lean());
  return {
    ...s,
    weekend_days: s.weekend_days || [0, 6],
    lateAfterSecs: hhmmToSecs(s.office_start) + s.grace_minutes * 60,
  };
}

async function update(patch) {
  await M.Settings.updateOne({ _id: 1 }, { $set: { ...patch, updated_at: new Date() } });
  return get();
}

async function getHolidaySet(from, to) {
  const rows = await M.Holiday.find({ date: { $gte: from, $lte: to } }).lean();
  return new Set(rows.map((r) => r.date));
}

module.exports = { get, update, getHolidaySet };

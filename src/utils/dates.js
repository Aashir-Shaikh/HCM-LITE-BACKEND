// All dates are 'YYYY-MM-DD' strings; arithmetic is done in UTC so there is no DST/offset drift.
const toMs = (d) => Date.parse(d + 'T00:00:00Z');
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);

const addDays = (d, n) => fromMs(toMs(d) + n * 86400000);
const dow = (d) => new Date(toMs(d)).getUTCDay(); // 0=Sun..6=Sat
const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / 86400000);

function eachDate(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function monthRange(m) {
  const [y, mo] = m.split('-').map(Number);
  const from = `${m}-01`;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from, to: `${m}-${String(last).padStart(2, '0')}` };
}

// "now" in the office timezone: { date, secs (since midnight), time:'HH:MM' }
function nowIn(tz, at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const h = Number(p.hour), m = Number(p.minute), s = Number(p.second);
  return { date: `${p.year}-${p.month}-${p.day}`, secs: h * 3600 + m * 60 + s, time: `${p.hour}:${p.minute}` };
}

const hhmmToSecs = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 3600 + m * 60;
};

const isWeekend = (d, weekendDays) => weekendDays.includes(dow(d));

// Working days in [from,to] excluding weekends + holidays (holidays: Set of date strings)
function workingDaysList(from, to, weekendDays, holidays) {
  if (from > to) return [];
  return eachDate(from, to).filter((d) => !isWeekend(d, weekendDays) && !holidays.has(d));
}

// Wall-clock 'YYYY-MM-DD' + 'HH:MM' in a time zone -> UTC Date (used for attendance corrections)
function zonedToUtc(date, hhmm, tz) {
  const [h, m] = hhmm.split(':').map(Number);
  const naive = Date.parse(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    const p = nowIn(tz, new Date(guess));
    const shown = Date.parse(`${p.date}T00:00:00Z`) + p.secs * 1000;
    guess += naive - shown;
  }
  return new Date(guess);
}

module.exports = { zonedToUtc, addDays, dow, diffDays, eachDate, monthRange, nowIn, hhmmToSecs, isWeekend, workingDaysList };

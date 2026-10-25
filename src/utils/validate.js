const { z } = require('zod');
const { HttpError } = require('./errors');

// Parse `data` with a zod schema; throw 400 with field-level details.
function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const details = r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message }));
    const first = details[0];
    throw new HttpError(400, first ? `${first.field || 'body'}: ${first.reason}` : 'Invalid input', details);
  }
  return r.data;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s + 'T00:00:00Z')), 'invalid date');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');
const id = z.coerce.number().int().positive();

module.exports = { z, parse, isoDate, month, hhmm, id };

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const bad = (m, d) => new HttpError(400, m, d);
const unauthorized = (m = 'Authentication required') => new HttpError(401, m);
const forbidden = (m = 'You do not have access to this resource') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);
const conflict = (m, d) => new HttpError(409, m, d);
const unprocessable = (m, d) => new HttpError(422, m, d);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { HttpError, bad, unauthorized, forbidden, notFound, conflict, unprocessable, wrap };

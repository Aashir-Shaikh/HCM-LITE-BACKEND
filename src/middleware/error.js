const { HttpError } = require('../utils/errors');

function notFoundHandler(req, _res, next) {
  next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { message: err.message, details: err.details } });
  }
  if (err && err.code === 11000) {
    const field = Object.keys(err.keyPattern || err.keyValue || {}).join(', ');
    return res.status(409).json({ error: { message: `Duplicate value${field ? ' for ' + field : ''}: record already exists` } });
  }
  if (err && err.name === 'ValidationError') {
    return res.status(400).json({ error: { message: Object.values(err.errors).map((e) => e.message).join('; ') } });
  }
  if (err && err.name === 'CastError') {
    return res.status(400).json({ error: { message: `Invalid value for ${err.path}` } });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Malformed JSON body' } });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: { message: 'Request body too large' } });
  }
  console.error('[error]', err);
  res.status(500).json({ error: { message: 'Internal server error' } });
}

module.exports = { notFoundHandler, errorHandler };

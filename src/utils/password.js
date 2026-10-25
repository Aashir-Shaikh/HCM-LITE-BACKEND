const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const hash = (pw) => bcrypt.hash(pw, 10);
const compare = (pw, h) => bcrypt.compare(pw, h);

// Readable temporary password, e.g. "Tmp-4f9a2c1b"
const tempPassword = () => 'Tmp-' + crypto.randomBytes(4).toString('hex');

function checkStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers';
  return null;
}

module.exports = { hash, compare, tempPassword, checkStrength };

/**
 * Password hashing helpers for the application layer (e-commerce users).
 *
 * Uses Node's built-in scrypt - no external dependency, no plain-text
 * storage. Stored format: "scrypt:<salt hex>:<hash hex>".
 *
 * The demo auth service keeps its own legacy store; this module is for the
 * domain UserProfile model and any future registration endpoints.
 */
const crypto = require('crypto');
const { promisify } = require('util');

const KEYLEN = 64;
const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(String(password), salt, KEYLEN)).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split(':');
  if (scheme !== 'scrypt' || !/^[0-9a-f]{32}$/i.test(salt || '') || !/^[0-9a-f]{128}$/i.test(hash || '')) return false;
  const expected = Buffer.from(hash, 'hex');
  const candidate = await scrypt(String(password), salt, KEYLEN);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

module.exports = { hashPassword, verifyPassword };

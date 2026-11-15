/**
 * Trusted proxy / client IP resolution.
 *
 * Trust model (P2.6.1):
 *   - The socket peer address is always the base truth.
 *   - Forwarded headers (X-Real-IP, X-Forwarded-For) are honoured ONLY when
 *     the socket peer is an explicitly trusted proxy. Trust is configured via
 *     the TRUSTED_PROXIES environment variable: exact IP addresses or IPv4
 *     CIDR ranges. Docker Compose trusts only its static nginx address.
 *     When TRUSTED_PROXIES is unset, only loopback peers are trusted, which
 *     preserves direct-development behaviour without trusting arbitrary
 *     private-network addresses.
 *   - Untrusted peers get their socket address as client identity and their
 *     forwarded headers are ignored outright.
 */
const { normalizeClientIp } = require('../middleware/rateLimit');
const net = require('net');

const DEFAULT_TRUSTED = ['127.0.0.1', '::1'];

function parseTrustedProxies() {
  const raw = process.env.TRUSTED_PROXIES;
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_TRUSTED;
  const entries = raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  return entries.length ? entries : DEFAULT_TRUSTED;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    acc = (acc << 8) + n; // eslint-disable-line no-bitwise
  }
  return acc >>> 0; // eslint-disable-line no-bitwise
}

function matchesTrustedEntry(peer, entry) {
  const slash = entry.indexOf('/');
  if (slash === -1) {
    const address = normalizeClientIp(entry);
    return net.isIP(address) !== 0 && address === peer;
  }
  if (net.isIP(entry.slice(0, slash)) !== 4) return false;
  const network = ipv4ToInt(entry.slice(0, slash));
  const bits = Number(entry.slice(slash + 1));
  const peerInt = ipv4ToInt(peer);
  if (network === null || peerInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0; // eslint-disable-line no-bitwise
  return ((network & mask) >>> 0) === ((peerInt & mask) >>> 0); // eslint-disable-line no-bitwise
}

function isTrustedProxy(peer) {
  const normalized = normalizeClientIp(peer);
  if (net.isIP(normalized) === 0) return false;
  return parseTrustedProxies().some((entry) => matchesTrustedEntry(normalized, entry));
}

function firstValidIp(value) {
  if (typeof value !== 'string') return null;
  for (const part of value.split(',')) {
    const candidate = part.trim();
    if (net.isIP(candidate) !== 0) return candidate;
  }
  return null;
}

/**
 * Resolve the client IP for a request:
 *   1. peer = normalized socket address.
 *   2. peer is not a trusted proxy -> peer (forwarded headers ignored).
 *   3. X-Real-IP present and valid -> normalized X-Real-IP (nginx sets this).
 *   4. X-Forwarded-For first valid entry -> normalized value.
 *   5. otherwise peer.
 */
function resolveClientIp(req) {
  const peer = normalizeClientIp(req.socket && req.socket.remoteAddress);
  if (!isTrustedProxy(peer)) return peer;
  const headers = req.headers || {};
  const real = firstValidIp(headers['x-real-ip']);
  if (real) return normalizeClientIp(real);
  const forwarded = firstValidIp(headers['x-forwarded-for']);
  if (forwarded) return normalizeClientIp(forwarded);
  return peer;
}

function overwriteForwardedFor(req) {
  if (!req.headers) req.headers = {};
  req.headers['x-forwarded-for'] = resolveClientIp(req);
  return req.headers['x-forwarded-for'];
}

module.exports = {
  isTrustedProxy,
  resolveClientIp,
  overwriteForwardedFor,
  parseTrustedProxies,
};

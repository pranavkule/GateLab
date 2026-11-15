/**
 * TEST SUITE (P2.6.1): trusted proxy handling and client-IP resolution.
 *
 * Unit-tests backend/security/trustedProxy.js with synthetic request objects:
 *   - trust is limited to loopback by default (no blanket private-range trust)
 *   - explicit TRUSTED_PROXIES configuration (exact IPs / IPv4 CIDR ranges)
 *   - forwarded headers are honoured only for trusted peers
 *   - untrusted peers get their socket address, forwarded headers ignored
 */
const {
  isTrustedProxy,
  resolveClientIp,
  overwriteForwardedFor,
  parseTrustedProxies,
} = require('../backend/security/trustedProxy');

const ORIGINAL_ENV = process.env.TRUSTED_PROXIES;

function setEnv(value) {
  if (value === undefined) delete process.env.TRUSTED_PROXIES;
  else process.env.TRUSTED_PROXIES = value;
}

function fakeReq({ remoteAddress, headers = {} }) {
  return { headers, socket: { remoteAddress } };
}

afterAll(() => {
  setEnv(ORIGINAL_ENV);
});

describe('isTrustedProxy (P2.6.1)', () => {
  test('default configuration trusts only loopback, not all private ranges', () => {
    setEnv(undefined);
    expect(isTrustedProxy('127.0.0.1')).toBe(true);
    expect(isTrustedProxy('::1')).toBe(true);
    expect(isTrustedProxy('::ffff:127.0.0.1')).toBe(true);
    // Private addresses are NOT blanket-trusted without explicit configuration.
    expect(isTrustedProxy('172.18.0.5')).toBe(false);
    expect(isTrustedProxy('10.0.0.7')).toBe(false);
    expect(isTrustedProxy('192.168.1.20')).toBe(false);
    expect(isTrustedProxy('8.8.8.8')).toBe(false);
    expect(isTrustedProxy('unknown')).toBe(false);
  });

  test('parseTrustedProxies falls back to loopback on empty/invalid values', () => {
    setEnv(undefined);
    expect(parseTrustedProxies()).toEqual(['127.0.0.1', '::1']);
    setEnv('   ');
    expect(parseTrustedProxies()).toEqual(['127.0.0.1', '::1']);
    setEnv('10.0.0.0/8');
    expect(parseTrustedProxies()).toEqual(['10.0.0.0/8']);
  });

  test('explicitly configured exact IP addresses are trusted', () => {
    setEnv('172.18.0.9, 2001:db8::1');
    expect(isTrustedProxy('172.18.0.9')).toBe(true);
    expect(isTrustedProxy('::ffff:172.18.0.9')).toBe(true);
    expect(isTrustedProxy('2001:db8::1')).toBe(true);
    expect(isTrustedProxy('172.18.0.10')).toBe(false);
  });

  test('matches exact IPv4 and IPv6 addresses, including mapped IPv4 peers', () => {
    setEnv('172.30.250.2, 2001:db8::1');
    expect(isTrustedProxy('172.30.250.2')).toBe(true);
    expect(isTrustedProxy('::ffff:172.30.250.2')).toBe(true);
    expect(isTrustedProxy('2001:db8::1')).toBe(true);
    expect(isTrustedProxy('2001:db8::2')).toBe(false);
  });

  test('explicitly configured IPv4 CIDR ranges are trusted, others are not', () => {
    setEnv('172.16.0.0/12,10.0.0.0/8');
    expect(isTrustedProxy('172.18.0.5')).toBe(true);
    expect(isTrustedProxy('172.31.255.255')).toBe(true);
    expect(isTrustedProxy('172.32.0.1')).toBe(false);
    expect(isTrustedProxy('10.255.0.1')).toBe(true);
    expect(isTrustedProxy('11.0.0.1')).toBe(false);
    expect(isTrustedProxy('8.8.8.8')).toBe(false);
  });

  test('handles /32, /0 and malformed entries defensively', () => {
    setEnv('192.168.1.50/32, not-a-cidr/40, 999.1.1.1/8');
    expect(isTrustedProxy('192.168.1.50')).toBe(true);
    expect(isTrustedProxy('192.168.1.51')).toBe(false);
    expect(isTrustedProxy('8.8.8.8')).toBe(false);
    expect(isTrustedProxy('999.1.1.1')).toBe(false);
    setEnv('0.0.0.0/0');
    expect(isTrustedProxy('8.8.8.8')).toBe(true); // /0 matches everything (explicit opt-in)
    expect(isTrustedProxy('192.168.1.51')).toBe(true);
  });
});

describe('resolveClientIp (P2.6.1)', () => {
  test('untrusted peer: forwarded headers are ignored, socket address wins', () => {
    setEnv(undefined); // only loopback trusted
    const req = fakeReq({
      remoteAddress: '172.18.0.5', // e.g. a container peer not in the trust list
      headers: { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' },
    });
    expect(resolveClientIp(req)).toBe('172.18.0.5');
  });

  test('trusted peer: X-Real-IP is honoured and normalized', () => {
    setEnv('172.16.0.0/12');
    const req = fakeReq({
      remoteAddress: '172.18.0.5',
      headers: { 'x-real-ip': '203.0.113.7' },
    });
    expect(resolveClientIp(req)).toBe('203.0.113.7');
    const mapped = fakeReq({
      remoteAddress: '172.18.0.5',
      headers: { 'x-real-ip': '::ffff:203.0.113.8' },
    });
    expect(resolveClientIp(mapped)).toBe('203.0.113.8');
  });

  test('trusted peer without X-Real-IP falls back to the first valid XFF entry', () => {
    setEnv('172.16.0.0/12');
    const req = fakeReq({
      remoteAddress: '172.18.0.5',
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    });
    expect(resolveClientIp(req)).toBe('203.0.113.9');
  });

  test('trusted peer with neither header keeps the socket address', () => {
    setEnv('172.16.0.0/12');
    const req = fakeReq({ remoteAddress: '172.18.0.5', headers: {} });
    expect(resolveClientIp(req)).toBe('172.18.0.5');
  });

  test('garbage forwarded values are skipped, not trusted', () => {
    setEnv(undefined); // loopback trusted
    const req = fakeReq({
      remoteAddress: '127.0.0.1',
      headers: {
        'x-real-ip': '999.1.1.1',
        'x-forwarded-for': '<script>alert(1)</script>, 999.1.1.1, 2001:db8::10',
      },
    });
    expect(resolveClientIp(req)).toBe('2001:db8::10');
  });

  test('untrusted peer cannot poison identity via chained XFF either', () => {
    setEnv('172.30.250.2');
    const req = fakeReq({
      remoteAddress: '8.8.8.8', // public peer, untrusted
      headers: { 'x-forwarded-for': '203.0.113.11', 'x-real-ip': '203.0.113.12' },
    });
    expect(resolveClientIp(req)).toBe('8.8.8.8');
  });

  test('untrusted IPv6 and mapped IPv4 peers cannot spoof forwarded identity', () => {
    setEnv('172.30.250.2');
    const ipv6 = fakeReq({
      remoteAddress: '2001:db8::20',
      headers: { 'x-real-ip': '203.0.113.20', 'x-forwarded-for': '203.0.113.21' },
    });
    expect(resolveClientIp(ipv6)).toBe('2001:db8::20');

    const mapped = fakeReq({
      remoteAddress: '::ffff:192.0.2.20',
      headers: { 'x-real-ip': '198.51.100.20', 'x-forwarded-for': '198.51.100.21' },
    });
    expect(resolveClientIp(mapped)).toBe('192.0.2.20');
  });

  test('trusted IPv6 proxy resolves IPv4-mapped and IPv6 client addresses', () => {
    setEnv('2001:db8::1');
    const mappedClient = fakeReq({
      remoteAddress: '2001:db8::1',
      headers: { 'x-real-ip': '::ffff:203.0.113.22' },
    });
    expect(resolveClientIp(mappedClient)).toBe('203.0.113.22');

    const ipv6Client = fakeReq({
      remoteAddress: '2001:db8::1',
      headers: { 'x-real-ip': '2001:db8::22' },
    });
    expect(resolveClientIp(ipv6Client)).toBe('2001:db8::22');
  });

  test('Entry LB overwrites forwarded identity using the shared trust policy', () => {
    setEnv('172.30.250.2');
    const trusted = fakeReq({
      remoteAddress: '172.30.250.2',
      headers: {
        'x-real-ip': '198.51.100.30',
        'x-forwarded-for': '1.1.1.1',
      },
    });
    expect(overwriteForwardedFor(trusted)).toBe('198.51.100.30');
    expect(trusted.headers['x-forwarded-for']).toBe('198.51.100.30');

    const untrusted = fakeReq({
      remoteAddress: '2001:db8::30',
      headers: {
        'x-real-ip': '198.51.100.31',
        'x-forwarded-for': '1.1.1.2',
      },
    });
    expect(overwriteForwardedFor(untrusted)).toBe('2001:db8::30');
    expect(untrusted.headers['x-forwarded-for']).toBe('2001:db8::30');
  });

  test('loopback peer with no headers resolves to loopback (dev behaviour)', () => {
    setEnv(undefined);
    expect(resolveClientIp(fakeReq({ remoteAddress: '::1' }))).toBe('127.0.0.1');
    expect(resolveClientIp(fakeReq({ remoteAddress: '127.0.0.1' }))).toBe('127.0.0.1');
  });

  test('missing socket address resolves to a safe sentinel', () => {
    setEnv(undefined);
    expect(resolveClientIp(fakeReq({ remoteAddress: undefined }))).toBe('unknown');
  });
});

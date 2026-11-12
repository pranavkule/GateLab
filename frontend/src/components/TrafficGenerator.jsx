import React, { useEffect, useState } from 'react';
import { Send, Zap, RotateCcw, LogIn, LogOut } from 'lucide-react';
import { api } from '../services/api';
import { ENTRY_LB_PORT, BACKEND_INSTANCES } from '../services/ports';

const ENDPOINTS = ['/api/users', '/api/products', '/api/orders'];
const SPEEDS = { slow: 350, normal: 120, fast: 30 };
const AUTH_LABELS = { none: 'No JWT (public/missing)', valid: 'Valid JWT', invalid: 'Invalid JWT', expired: 'Expired JWT' };

// First two configured instances of the User Service (used by the failure scenario).
const USER_INSTANCES = BACKEND_INSTANCES.users;

// Client-side JWT payload decode (display only - NO verification, NO secret,
// token never rendered). Returns null for unreadable payloads.
function jwtPayload(token) {
  try {
    const part = token.split('.')[1];
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  } catch (_) {
    return null;
  }
}

/**
 * Traffic generator. Sends REAL HTTP requests through the entry load
 * balancer on :{ENTRY_LB_PORT} - every metric and log row on this page is
 * produced by these requests.
 */
export default function TrafficGenerator({ notify, onScenario, token, setToken }) {
  const [method, setMethod] = useState('GET');
  const [endpoint, setEndpoint] = useState('/api/users');
  const [auth, setAuth] = useState('none'); // none | valid | invalid | expired
  const [count, setCount] = useState(10);
  const [speed, setSpeed] = useState('normal');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState({ sent: 0, ok: 0, failed: 0 });
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');

  // Re-render every second so the token validity state stays current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const claims = token ? jwtPayload(token) : null;
  const expiresAt = claims && claims.exp ? claims.exp * 1000 : null;
  const tokenExpired = expiresAt != null && Date.now() >= expiresAt;
  const tokenUsable = Boolean(token) && !tokenExpired;
  const validAuthAvailable = auth !== 'valid' || tokenUsable;

  async function resolveToken() {
    if (auth === 'none') return null;                       // 2. no Authorization header
    if (auth === 'invalid') return 'this.is.not.a.valid.jwt'; // 3. malformed token
    if (auth === 'expired') {
      // Expired JWT is minted by the authentication service on purpose.
      try { return (await api.demoToken('expired')).token; } catch { return null; }
    }
    // auth === 'valid': ONLY the token obtained from the Authentication
    // Service via real login - never a server-side demo mint.
    if (!tokenUsable) return null; // guarded before send; keeps type honest
    return token;
  }

  async function login() {
    try {
      const res = await api.login(username, password);
      setToken(res.token);
      notify(`Logged in as ${res.user.username} - valid JWT ready`, 'success');
    } catch (e) {
      notify('Login failed: ' + e.message, 'error');
    }
  }

  async function runTraffic(n) {
    if (!validAuthAvailable) {
      notify('Login required - no valid JWT in memory. Log in below first.', 'warn');
      return;
    }
    setRunning(true);
    setResults({ sent: 0, ok: 0, failed: 0 });
    const t = await resolveToken();
    const delay = n === 1 ? 0 : SPEEDS[speed];
    let ok = 0, failed = 0;
    for (let i = 0; i < n; i++) {
      const r = await api.send({ method, path: endpoint, token: t });
      if (r.ok) ok++; else failed++;
      setResults({ sent: i + 1, ok, failed });
      if (delay) await new Promise((res) => setTimeout(res, delay));
    }
    setRunning(false);
    notify(`Sent ${n} ${method} ${endpoint} - ${ok} ok / ${failed} failed`, 'info');
  }

  // Quick lab scenarios (each generates real traffic)
  async function scenario(type) {
    switch (type) {
      case 'valid-jwt':
        if (!tokenUsable) {
          notify('Login required - no valid JWT in memory. Log in below first.', 'warn');
          break;
        }
        await api.send({ path: '/api/users', token }); // real login token
        notify('Sent valid-JWT request to /api/users (protected)', 'info');
        break;
      case 'missing-jwt':
        await api.send({ path: '/api/users' });
        notify('Sent request without JWT to /api/users (protected)', 'info');
        break;
      case 'invalid-jwt':
        await api.send({ path: '/api/users', token: 'this.is.not.a.valid.jwt' });
        notify('Sent invalid-JWT request to /api/users (protected)', 'info');
        break;
      case 'expired-jwt': {
        const expired = await api.demoToken('expired').then((r) => r.token).catch(() => null);
        await api.send({ path: '/api/users', token: expired });
        notify('Sent expired-JWT request to /api/users (protected)', 'info');
        break;
      }
      case 'route-change':
        onScenario('route-change');
        break;
      case 'backend-failure': {
        const first = USER_INSTANCES[0];
        const second = USER_INSTANCES[1] || first;
        await api.backendAction(first, 'fail');
        notify(`User Service instance :${first} is now OFFLINE - watch the LB route to :${second}. Recover it from the service card.`, 'warn');
        break;
      }
      default:
        break;
    }
    setResults((r) => ({ ...r }));
  }

  return (
    <section className="card side-card">
      <div className="card-head"><h2>Traffic Generator</h2></div>

      <label className="field">
        <span>HTTP Method</span>
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {['GET', 'POST', 'PUT', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
        </select>
      </label>

      <label className="field">
        <span>API Endpoint</span>
        <select value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
          {ENDPOINTS.map((e) => <option key={e}>{e}</option>)}
        </select>
      </label>

      <label className="field">
        <span>Authentication</span>
        <select value={auth} onChange={(e) => setAuth(e.target.value)}>
          <option value="none">No JWT (public/missing)</option>
          <option value="valid">Valid JWT</option>
          <option value="invalid">Invalid JWT</option>
          <option value="expired">Expired JWT</option>
        </select>
      </label>
      <div className="muted tiny" style={{ marginTop: -6, marginBottom: 6 }}>
        Requests are sent as: <b>{AUTH_LABELS[auth]}</b>
        {auth === 'valid' && tokenUsable && <span className="c-green"> - Authenticated</span>}
        {auth === 'valid' && !tokenUsable && <span className="c-red"> - Login required</span>}
      </div>

      <div className="field-row">
        <label className="field">
          <span>Request count</span>
          <input type="number" min="1" max="500" value={count} onChange={(e) => setCount(Math.max(1, Math.min(500, Number(e.target.value))))} />
        </label>
        <label className="field">
          <span>Speed</span>
          <select value={speed} onChange={(e) => setSpeed(e.target.value)}>
            <option value="slow">Slow</option>
            <option value="normal">Normal</option>
            <option value="fast">Fast</option>
          </select>
        </label>
      </div>

      <button className="btn btn-primary btn-block" disabled={running || !validAuthAvailable} onClick={() => runTraffic(count)}>
        <Send size={14} /> {running ? `Sending... (${results.sent}/${count})` : !validAuthAvailable ? 'Login required' : `Send ${count} Requests`}
      </button>
      <button className="btn btn-outline-blue btn-block" disabled={running || !validAuthAvailable} onClick={() => runTraffic(1)}>
        <Zap size={14} /> Send Single Request
      </button>
      <button className="btn btn-outline-blue btn-block" onClick={async () => { await api.resetLab(); notify('Lab counters reset (config history preserved)', 'info'); }}>
        <RotateCcw size={14} /> Reset Counts
      </button>

      {running && (
        <div className="mini-stats">
          <span>Sent: <b>{results.sent}</b></span>
          <span className="c-green">OK: <b>{results.ok}</b></span>
          <span className="c-red">Failed: <b>{results.failed}</b></span>
        </div>
      )}

      <div className="divider" />
      <div className="card-head"><h3>Quick Scenarios</h3></div>
      <div className="scenario-grid">
        <button className="btn btn-scenario" onClick={() => scenario('valid-jwt')}>1. Valid JWT Request</button>
        <button className="btn btn-scenario" onClick={() => scenario('missing-jwt')}>2. Missing JWT Request</button>
        <button className="btn btn-scenario" onClick={() => scenario('invalid-jwt')}>3. Invalid JWT Request</button>
        <button className="btn btn-scenario" onClick={() => scenario('expired-jwt')}>4. Expired JWT Request</button>
        <button className="btn btn-scenario" onClick={() => scenario('route-change')}>5. Dynamic Route Change</button>
        <button className="btn btn-scenario" onClick={() => scenario('backend-failure')}>6. Backend Failure</button>
      </div>

      <div className="divider" />
      <div className="card-head"><h3>Demo Login</h3></div>
      <div className="field-row">
        <label className="field"><span>User</span><input value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label className="field"><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      </div>
      <button className="btn btn-outline-blue btn-block" onClick={login}>
        <LogIn size={14} /> Login &amp; Get JWT
      </button>
      {token && claims ? (
        <div className="mini-stats">
          <span>{tokenExpired ? 'JWT expired:' : 'Authenticated:'} <b>{claims.sub}</b></span>
          <span className={tokenExpired ? 'c-red' : 'c-green'}>
            JWT {tokenExpired ? 'EXPIRED' : `valid until ${new Date(expiresAt).toLocaleTimeString()}`}
          </span>
          <button className="btn btn-xs btn-outline-red" onClick={() => { setToken(null); notify('JWT cleared from memory', 'info'); }}>
            <LogOut size={11} /> Clear JWT
          </button>
        </div>
      ) : (
        <div className="muted tiny">{tokenExpired ? 'JWT expired - log in again' : 'admin / admin123'}</div>
      )}
    </section>
  );
}

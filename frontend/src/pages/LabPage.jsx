import React, { useState } from 'react';
import TrafficGenerator from '../components/TrafficGenerator';
import Gateways from '../components/Gateways';
import Backends from '../components/Backends';
import CircuitBreakers from '../components/CircuitBreakers';
import SystemOverview from '../components/SystemOverview';
import RequestLogs from '../components/RequestLogs';
import { api } from '../services/api';
import { BACKEND_INSTANCES } from '../services/ports';
import { isAdmin } from '../services/roles';
import { useLab } from '../hooks/useLab';
import { useStore } from '../store/StoreContext';

export default function LabPage() {
  const lab = useLab();
  const { token, login, logout, user } = useStore();
  const canManage = isAdmin(user);
  const [autoRecover, setAutoRecover] = useState(null);

  // Dynamic Route Change scenario: swap /api/products/* -> orders, then back.
  async function scenarioRouteChange() {
    try {
      const cfg = await api.getLatestConfig();
      const original = cfg.routes.map((r) => ({ ...r }));
      const changed = original.map((r) => r.id === 'r-products' ? { ...r, targetService: 'orders' } : r);
      await api.applyConfig(changed);
      lab.notify('Route change applied: /api/products/* now targets Order Service - send a request to see it', 'warn');
      setAutoRecover('route-change');
      setTimeout(async () => {
        await api.applyConfig(original);
        setAutoRecover(null);
      }, 10000);
    } catch (e) {
      lab.notify('Route change failed: ' + e.message, 'error');
    }
  }

  // Rate Limiting scenario: apply a strict 5 req / 15 s limit to /api/products,
  // burst 10 REAL requests through the entry load balancer, report every HTTP
  // status, then ALWAYS restore the original configuration (finally-style).
  // Every status shown comes from the live gateway; nothing is simulated.
  async function scenarioRateLimit() {
    let original = null;
    setAutoRecover('rate-limit');
    try {
      const cfg = await api.getLatestConfig();
      original = cfg.routes.map((r) => ({ ...r }));
      const limited = original.map((r) => r.path.startsWith('/api/products') ? { ...r, rateLimit: { limit: 5, windowMs: 15000 } } : r);
      await api.applyConfig(limited);
      lab.notify('Rate limit applied: /api/products/* limited to 5 requests / 15 s - sending 10 rapid requests...', 'warn');
      await new Promise((r) => setTimeout(r, 700)); // let the config snapshot reach every gateway
      const statuses = [];
      for (let i = 0; i < 10; i++) {
        const res = await api.send({ method: 'GET', path: '/api/products' });
        statuses.push(res.status);
      }
      const ok = statuses.filter((s) => s === 200).length;
      const blocked = statuses.filter((s) => s === 429).length;
      lab.notify(
        `Rate limit demo results: [${statuses.join(', ')}] — ${ok} succeeded, ${blocked} rate-limited with 429 + Retry-After. Restoring configuration...`,
        blocked > 0 ? 'success' : 'warn'
      );
    } catch (e) {
      lab.notify('Rate limit scenario failed: ' + e.message, 'error');
    } finally {
      if (original) {
        try { await api.applyConfig(original); } catch (_) { /* restore best-effort */ }
      }
      setAutoRecover(null);
    }
  }

  // Circuit Breaker scenario (P2.5.2): inject 100% errors on BOTH Product
  // Service instances, burst real requests through the entry LB until the
  // shared Redis circuits OPEN, observe the blocked 503 circuit_open window,
  // clear the error injection, wait out the cooldown and send HALF-OPEN
  // probes that close the circuits again automatically. Nothing is faked -
  // every status comes from the live stack and the Circuit Breakers card /
  // Backends rows show the state transitions live.
  async function scenarioCircuitBreaker() {
    const targets = (BACKEND_INSTANCES.products || []).slice(0, 2);
    if (targets.length === 0) {
      lab.notify('No Product Service instances configured', 'error');
      return;
    }
    setAutoRecover('circuit-breaker');
    try {
      for (const port of targets) await api.backendAction(port, 'errors', { rate: 1 });
      lab.notify('Circuit breaker demo: 100% errors injected on Product Service - sending a burst of real requests...', 'warn');
      const statuses = [];
      let retryAfterMs = 0;
      for (let i = 0; i < 14; i++) {
        const r = await api.send({ method: 'GET', path: '/api/products' });
        statuses.push(r.status);
        if (r.status === 503 && r.body && r.body.retryAfterMs > retryAfterMs) retryAfterMs = r.body.retryAfterMs;
        await new Promise((res) => setTimeout(res, 60));
      }
      const failed = statuses.filter((s) => s === 500).length;
      const blocked = statuses.filter((s) => s === 503).length;
      lab.notify(`Phase 1-2: ${failed} upstream 500s opened the circuits, then ${blocked} requests were BLOCKED with 503 circuit_open. Error injection cleared - waiting for the cooldown...`, 'warn');
      for (const port of targets) await api.backendAction(port, 'errors', { rate: 0 });
      // The 503 bodies carry the real remaining cooldown; fall back to the
      // documented default (10 s) when no request was blocked.
      const cooldownMs = retryAfterMs > 0 ? retryAfterMs + 800 : 10800;
      await new Promise((res) => setTimeout(res, cooldownMs));
      lab.notify('Cooldown over - circuits are HALF-OPEN: only probe requests are admitted now...', 'info');
      const probes = [];
      for (let i = 0; i < 4; i++) {
        const r = await api.send({ method: 'GET', path: '/api/products' });
        probes.push(r.status);
        await new Promise((res) => setTimeout(res, 700));
      }
      const recovered = probes.filter((s) => s === 200).length;
      lab.notify(`Phase 3-4: HALF-OPEN probes returned [${probes.join(', ')}] - ${recovered} successful probe(s) closed the circuits automatically.`, recovered > 0 ? 'success' : 'warn');
    } catch (e) {
      lab.notify('Circuit breaker scenario failed: ' + e.message, 'error');
    } finally {
      for (const port of targets) { try { await api.backendAction(port, 'errors', { rate: 0 }); } catch (_) { /* best effort */ } }
      setAutoRecover(null);
    }
  }

  const SCENARIOS = {
    'route-change': scenarioRouteChange,
    'rate-limit': scenarioRateLimit,
    'circuit-breaker': scenarioCircuitBreaker,
  };

  return (
    <div className="lab-page">
      <div className="lab-grid">
        <aside className="lab-left">
          <TrafficGenerator
            notify={lab.notify}
            onScenario={(type) => (SCENARIOS[type] || scenarioRouteChange)()}
            token={token}
            setToken={(result) => result ? login(result) : logout()}
            canManage={canManage}
          />
        </aside>

        <main className="lab-main">
          {autoRecover === 'route-change' && (
            <div className="banner banner-orange">Dynamic route change active: /api/products/* -> Order Service (auto-restores in 10 s)</div>
          )}
          {autoRecover === 'rate-limit' && (
            <div className="banner banner-orange">Rate limit demo active: /api/products/* = 5 requests / 15 s (restoring configuration...)</div>
          )}
          {autoRecover === 'circuit-breaker' && (
            <div className="banner banner-orange">Circuit breaker demo active: opening circuits on Product Service, then blocked requests - cooldown - HALF-OPEN probes (auto-recovers)</div>
          )}
          <SystemOverview overview={lab.overview} history={lab.history} connected={lab.connected} circuits={lab.circuits} />
          <Gateways gatewayHealth={lab.gatewayHealth} gatewayMetrics={lab.gatewayMetrics} notify={lab.notify} canManage={canManage} />
          <Backends backendHealth={lab.backendHealth} backendMetrics={lab.backendMetrics} circuits={lab.circuits} notify={lab.notify} canManage={canManage} />
          <CircuitBreakers circuits={lab.circuits} />
          <RequestLogs newLogs={lab.newLogs} notify={lab.notify} canManage={canManage} />
        </main>
      </div>
      {lab.toast && <div className={`toast toast-${lab.toast.kind}`}>{lab.toast.message}</div>}
    </div>
  );
}

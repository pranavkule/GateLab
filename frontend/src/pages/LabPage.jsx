import React, { useState } from 'react';
import TrafficGenerator from '../components/TrafficGenerator';
import Gateways from '../components/Gateways';
import Backends from '../components/Backends';
import SystemOverview from '../components/SystemOverview';
import RequestLogs from '../components/RequestLogs';
import { api } from '../services/api';
import { useLab } from '../hooks/useLab';
import { useStore } from '../store/StoreContext';

export default function LabPage() {
  const lab = useLab();
  const { token, login, logout } = useStore();
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

  return (
    <div className="lab-page">
      <div className="lab-grid">
        <aside className="lab-left">
          <TrafficGenerator
            notify={lab.notify}
            onScenario={(type) => (type === 'rate-limit' ? scenarioRateLimit() : scenarioRouteChange())}
            token={token}
            setToken={(result) => result ? login(result) : logout()}
          />
        </aside>

        <main className="lab-main">
          {autoRecover === 'route-change' && (
            <div className="banner banner-orange">Dynamic route change active: /api/products/* -> Order Service (auto-restores in 10 s)</div>
          )}
          {autoRecover === 'rate-limit' && (
            <div className="banner banner-orange">Rate limit demo active: /api/products/* = 5 requests / 15 s (restoring configuration...)</div>
          )}
          <SystemOverview overview={lab.overview} history={lab.history} connected={lab.connected} />
          <Gateways gatewayHealth={lab.gatewayHealth} gatewayMetrics={lab.gatewayMetrics} notify={lab.notify} />
          <Backends backendHealth={lab.backendHealth} backendMetrics={lab.backendMetrics} notify={lab.notify} />
          <RequestLogs newLogs={lab.newLogs} notify={lab.notify} />
        </main>
      </div>
      {lab.toast && <div className={`toast toast-${lab.toast.kind}`}>{lab.toast.message}</div>}
    </div>
  );
}

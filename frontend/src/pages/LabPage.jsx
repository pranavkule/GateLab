import React, { useState } from 'react';
import TrafficGenerator from '../components/TrafficGenerator';
import Gateways from '../components/Gateways';
import Backends from '../components/Backends';
import SystemOverview from '../components/SystemOverview';
import RequestLogs from '../components/RequestLogs';
import { api } from '../services/api';
import { useLab } from '../hooks/useLab';

export default function LabPage() {
  const lab = useLab();
  const [token, setToken] = useState(null);
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

  return (
    <div className="lab-page">
      <div className="lab-grid">
        <aside className="lab-left">
          <TrafficGenerator
            notify={lab.notify}
            onScenario={scenarioRouteChange}
            token={token}
            setToken={setToken}
          />
        </aside>

        <main className="lab-main">
          {autoRecover === 'route-change' && (
            <div className="banner banner-orange">Dynamic route change active: /api/products/* -> Order Service (auto-restores in 10 s)</div>
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

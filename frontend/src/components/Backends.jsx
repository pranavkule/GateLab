import React from 'react';
import { Power, Play, Timer, AlertTriangle } from 'lucide-react';
import { api } from '../services/api';
import { BACKEND_INSTANCES, SERVICE_NAMES } from '../services/ports';

function Dot({ status }) {
  return <span className={`dot dot-${status}`} />;
}

/**
 * Three microservices x two instances (ports from frontend/.env). Health is actively
 * polled by the control plane; a failed instance stops receiving new
 * traffic because the gateways exclude it from load balancing.
 */
export default function Backends({ backendHealth, backendMetrics, notify }) {
  // Configured instances per service (from frontend/.env). If the control
  // plane reports extra instances they are picked up from live health data.
  const services = Object.keys(BACKEND_INSTANCES).map((key) => {
    const configured = BACKEND_INSTANCES[key];
    const live = Object.values(backendHealth || {})
      .filter((h) => h.service === key && !configured.includes(String(h.port)))
      .map((h) => String(h.port));
    return { key, name: SERVICE_NAMES[key] || key, instances: [...configured, ...live] };
  });

  async function act(port, action, body, label) {
    try {
      await api.backendAction(port, action, body);
      notify(label, action === 'fail' ? 'warn' : 'success');
    } catch (e) {
      notify(`${label} failed: ${e.message}`, 'error');
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Backend Services</h2>
        <span className="muted">Two instances per service &middot; health-checked &middot; latency = backend processing</span>
      </div>
      <div className="grid-3">
        {services.map((svc) => {
          const instances = svc.instances.map((p) => ({ port: p, h: backendHealth[p] || {}, m: backendMetrics.find((b) => String(b.port) === String(p)) || {} }));
          const active = instances.filter((i) => i.h.healthy !== false).length;
          const svcMetrics = backendMetrics.filter((b) => b.service === svc.key);
          const reqCount = svcMetrics.reduce((s, b) => s + (b.requests || 0), 0);
          const errCount = svcMetrics.reduce((s, b) => s + (b.errors || 0), 0);
          // Request-weighted backend PROCESSING latency (measured inside each
          // instance). null = no measurements yet -> displayed as '-'.
          const withData = svcMetrics.filter((b) => b.requests > 0);
          const totalReqs = withData.reduce((s, b) => s + (b.requests || 0), 0);
          const avgLat = totalReqs ? Math.round(withData.reduce((s, b) => s + (b.avgLatency || 0) * b.requests, 0) / totalReqs) : null;
          return (
            <div className="instance-card" key={svc.key}>
              <div className="instance-title">
                <Dot status={active === 0 ? 'offline' : active === 1 ? 'degraded' : 'online'} />
                <div>
                  <div className="instance-name">{svc.name}</div>
                  <div className="instance-sub">/api/{svc.key}/*</div>
                </div>
              </div>
              <div className="instance-stats">
                <div><span>Active</span><b>{active}/2</b></div>
                <div><span>Requests</span><b>{reqCount}</b></div>
                <div><span>Errors</span><b className="c-red">{errCount}</b></div>
                <div><span>Avg latency</span><b>{avgLat != null ? `${avgLat} ms` : '-'}</b></div>
              </div>
              <div className="instance-list">
                {instances.map((i) => (
                  <div className="instance-row" key={i.port}>
                    <Dot status={i.h.healthy === false ? 'offline' : 'online'} />
                    <span>:{i.port}</span>
                    <span className="muted">{i.m.requests || 0} reqs</span>
                    <div className="instance-row-actions">
                      <button className="btn btn-xs btn-outline-red" disabled={i.h.healthy === false} onClick={() => act(i.port, 'fail', null, `Instance :${i.port} failed`)}><Power size={11} /> Fail</button>
                      <button className="btn btn-xs btn-outline-green" disabled={i.h.healthy !== false} onClick={() => act(i.port, 'recover', null, `Instance :${i.port} recovered`)}><Play size={11} /> Recover</button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="instance-actions">
                <button className="btn btn-sm btn-outline-orange" onClick={() => act(instances[0].port, 'latency', { ms: 400 }, `Simulated 400 ms latency on :${instances[0].port}`)}>
                  <Timer size={13} /> Simulate Latency
                </button>
                <button className="btn btn-sm btn-outline-orange" onClick={() => act(instances[0].port, 'errors', { rate: 0.4 }, `Simulated 40% errors on :${instances[0].port}`)}>
                  <AlertTriangle size={13} /> Simulate Errors
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

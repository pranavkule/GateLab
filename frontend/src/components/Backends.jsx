import React from 'react';
import { Power, Play, Timer, AlertTriangle } from 'lucide-react';
import { api } from '../services/api';

function Dot({ status }) {
  return <span className={`dot dot-${status}`} />;
}

/**
 * Three microservices x two instances (4001-4006). Health is actively
 * polled by the control plane; a failed instance stops receiving new
 * traffic because the gateways exclude it from load balancing.
 */
export default function Backends({ backendHealth, backendMetrics, notify }) {
  const services = [
    { key: 'users', name: 'User Service', instances: [4001, 4004], route: '/api/users/*' },
    { key: 'products', name: 'Product Service', instances: [4002, 4005], route: '/api/products/*' },
    { key: 'orders', name: 'Order Service', instances: [4003, 4006], route: '/api/orders/*' },
  ];

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
        <span className="muted">Two independent instances per service &middot; health-checked</span>
      </div>
      <div className="grid-3">
        {services.map((svc) => {
          const instances = svc.instances.map((p) => ({ port: p, h: backendHealth[p] || {}, m: backendMetrics.find((b) => b.port === p) || {} }));
          const active = instances.filter((i) => i.h.healthy !== false).length;
          const svcMetrics = backendMetrics.filter((b) => b.service === svc.key);
          const reqCount = svcMetrics.reduce((s, b) => s + (b.requests || 0), 0);
          const errCount = svcMetrics.reduce((s, b) => s + (b.errors || 0), 0);
          const lats = svcMetrics.filter((b) => b.requests > 0).map((b) => b.avgLatency || 0).filter(Boolean);
          const avgLat = lats.length ? Math.round(lats.reduce((s, l) => s + l, 0) / lats.length) : 0;
          return (
            <div className="instance-card" key={svc.key}>
              <div className="instance-title">
                <Dot status={active === 0 ? 'offline' : active === 1 ? 'degraded' : 'online'} />
                <div>
                  <div className="instance-name">{svc.name}</div>
                  <div className="instance-sub">{svc.route}</div>
                </div>
              </div>
              <div className="instance-stats">
                <div><span>Active</span><b>{active}/2</b></div>
                <div><span>Requests</span><b>{reqCount}</b></div>
                <div><span>Errors</span><b className="c-red">{errCount}</b></div>
                <div><span>Avg latency</span><b>{reqCount ? `${avgLat} ms` : '-'}</b></div>
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

import React from 'react';
import { Power, Play, Server } from 'lucide-react';
import { api } from '../services/api';
import { ENTRY_LB_PORT, GATEWAY_PORTS } from '../services/ports';

function statusOf(health, metrics) {
  if (!health) return { key: 'unknown', label: 'Starting...' };
  if (!health.healthy) return { key: 'offline', label: 'Offline' };
  if (health.degraded) return { key: 'degraded', label: 'Degraded' };
  return { key: 'online', label: 'Online' };
}

function Dot({ status }) {
  return <span className={`dot dot-${status}`} />;
}

/**
 * Three real gateway instances. Metrics come from each gateway process via
 * Socket.IO; health comes from active polling. Simulate/Recover change the
 * actual request handling on the gateway process.
 */
export default function Gateways({ gatewayHealth, gatewayMetrics, notify }) {
  // Live truth first: the control plane keys health by the real gateway
  // ports. Fall back to configured ports when no snapshot arrived yet.
  const ports = (Object.keys(gatewayHealth || {}).length
    ? Object.keys(gatewayHealth)
    : GATEWAY_PORTS
  ).sort((a, b) => Number(a) - Number(b));

  // Real distribution: share of total gateway-handled requests.
  const totalGatewayRequests = (gatewayMetrics || []).reduce((s, g) => s + (g.requests || 0), 0);

  async function act(port, action, label) {
    try {
      await api.gatewayAction(port, action);
      notify(`${label} gateway-${port}`, action === 'fail' ? 'warn' : 'success');
    } catch (e) {
      notify(`${label} failed: ${e.message}`, 'error');
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Gateway Instances</h2>
        <span className="muted">Entry LB :{ENTRY_LB_PORT} -> round-robin across healthy gateways &middot; latency = end-to-end</span>
      </div>
      <div className="grid-3">
        {ports.map((port, i) => {
          const h = gatewayHealth[port] || {};
          const m = gatewayMetrics.find((g) => g.source === `gateway-${port}`) || {};
          const st = statusOf(h);
          const avg = m.requests ? Math.round((m.avgLatency || 0)) : 0;
          const share = totalGatewayRequests ? Math.round((100 * (m.requests || 0)) / totalGatewayRequests) : null;
          return (
            <div className="instance-card" key={port}>
              <div className="instance-title">
                <Dot status={st.key} />
                <div>
                  <div className="instance-name">Gateway {i + 1}</div>
                  <div className="instance-sub">:{port} &middot; {st.label}{share != null ? ` · ${share}% of traffic` : ''}</div>
                </div>
                <Server size={16} className="muted-icon" />
              </div>
              <div className="instance-stats">
                <div><span>Requests</span><b>{m.requests || 0}</b></div>
                <div><span>Success</span><b className="c-green">{m.success || 0}</b></div>
                <div><span>Failed</span><b className="c-red">{m.failed || 0}</b></div>
                <div><span>Avg latency</span><b>{m.requests ? `${avg} ms` : '-'}</b></div>
                <div><span>Share</span><b>{share != null ? `${share}%` : '-'}</b></div>
              </div>
              <div className="instance-actions">
                <button className="btn btn-sm btn-outline-red" onClick={() => act(port, 'fail', 'Simulated failure of')} disabled={h && h.healthy === false}>
                  <Power size={13} /> Simulate Failure
                </button>
                <button className="btn btn-sm btn-outline-green" onClick={() => act(port, 'recover', 'Recovered')} disabled={h && h.healthy !== false}>
                  <Play size={13} /> Recover
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

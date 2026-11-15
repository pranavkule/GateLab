import React from 'react';
import { ShieldQuestion } from 'lucide-react';
import { BACKEND_INSTANCES, SERVICE_NAMES } from '../services/ports';

function CircuitBadge({ state }) {
  const map = {
    closed: { cls: 'badge-green', label: 'CLOSED' },
    open: { cls: 'badge-red', label: 'OPEN' },
    'half-open': { cls: 'badge-orange', label: 'HALF-OPEN' },
  };
  const s = map[state] || { cls: 'badge-gray', label: String(state || 'unknown') };
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}

/**
 * P2.5.2: dedicated circuit-breaker monitor. Shows the live state of every
 * BACKEND-INSTANCE circuit in the shared Redis store (CLOSED / OPEN /
 * HALF-OPEN), its consecutive-failure count, used HALF-OPEN probe slots and
 * the remaining cooldown. All values arrive with the 1 s gateway metric
 * snapshots over Socket.IO - nothing here is simulated. Circuit state is
 * distinct from administrative health: a healthy instance can have an OPEN
 * circuit and vice versa.
 */
export default function CircuitBreakers({ circuits }) {
  const values = Object.values(circuits || {});
  const open = values.filter((c) => c.state === 'open').length;
  const halfOpen = values.filter((c) => c.state === 'half-open').length;

  const services = Object.keys(BACKEND_INSTANCES).map((key) => ({
    key,
    name: SERVICE_NAMES[key] || key,
    instances: BACKEND_INSTANCES[key],
  }));

  return (
    <section className="card">
      <div className="card-head">
        <h2><ShieldQuestion size={15} /> Circuit Breakers</h2>
        <span className="muted">
          Shared Redis state per instance &middot; {values.length} circuits &middot;{' '}
          <span className="c-green">{values.length - open - halfOpen} closed</span>
          {open > 0 && <span className="c-red"> &middot; {open} open</span>}
          {halfOpen > 0 && <span className="c-orange"> &middot; {halfOpen} half-open</span>}
        </span>
      </div>
      {values.length === 0 ? (
        <div className="muted tiny">Waiting for the first gateway metrics snapshot...</div>
      ) : (
        <div className="circuit-grid">
          {services.map((svc) => (
            <div className="circuit-service" key={svc.key}>
              <div className="circuit-service-name">{svc.name} <span className="muted tiny">/api/{svc.key}/*</span></div>
              {svc.instances.map((port) => {
                const c = (circuits || {})[String(port)] || { state: 'unknown', failures: 0, probes: 0, retryAfterMs: 0 };
                return (
                  <div className="circuit-row" key={port}>
                    <CircuitBadge state={c.state} />
                    <span className="mono">:{port}</span>
                    <span className="muted tiny">
                      {c.state === 'open' && c.retryAfterMs > 0
                        ? `blocked - probe in ~${Math.ceil(c.retryAfterMs / 1000)} s`
                        : c.state === 'half-open'
                          ? `probing (${c.probes || 0} slot${(c.probes || 0) === 1 ? '' : 's'} used)`
                          : `${c.failures || 0} consecutive failure${(c.failures || 0) === 1 ? '' : 's'}`}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <div className="circuit-legend">
        <b>State machine:</b> CLOSED (normal traffic, consecutive failures counted) &rarr; OPEN after the failure
        threshold (blocks requests, answers 503 circuit_open) &rarr; HALF-OPEN after the cooldown (only probe
        requests admitted) &rarr; a successful probe closes the circuit again, a failed probe reopens it.
        Active health checks and manual Recover behaviour are documented in the Guide.
      </div>
    </section>
  );
}

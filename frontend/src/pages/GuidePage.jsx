import React from 'react';
import { Link } from 'react-router-dom';

const CONCEPTS = [
  {
    title: 'What is a Layer 7 API Gateway?',
    body: 'A single entry door for all API traffic. Sitting at Layer 7 (HTTP) it understands URLs, methods, headers and bodies - so it can route /api/users to one service and /api/orders to another, check authentication per route, and reject or forward requests before they reach your microservices. EdgeGate runs three independent gateway instances so the door is never single point of failure.',
  },
  {
    title: 'What is a Reverse Proxy?',
    body: 'A server that forwards client requests to backend servers on their behalf. The client talks only to the gateway; the gateway copies the method, path, headers and body to the chosen backend and relays the response. Backends stay hidden, and the gateway can add cross-cutting behaviour (auth, metrics, retries) in one place.',
  },
  {
    title: 'What is Dynamic Routing?',
    body: 'The routing table (path pattern -> target service -> auth required) is data, not code. When you edit the table and click Apply, the new version is stored in MongoDB, published over Redis Pub/Sub, and every gateway replaces its in-memory table atomically - in-flight requests finish on the old table, new requests use the new one. No gateway restart needed.',
  },
  {
    title: 'What is JWT Authentication?',
    body: 'A JWT is a signed JSON object carrying who you are (sub), what you can do (role), when it was issued (iat) and when it expires (exp). The auth service signs it with a secret that lives only on the server. Gateways verify the signature and expiry on protected routes; public routes skip the check. Missing, invalid or expired tokens get a clean 401.',
  },
  {
    title: 'What is Load Balancing?',
    body: 'Spreading traffic across several identical servers for capacity and fault tolerance. EdgeGate has two layers: the entry load balancer on :3000 round-robins across healthy gateways, and each gateway round-robins across healthy instances of the target service. Unhealthy instances are skipped automatically; if all instances of a service are down the client gets 503.',
  },
  {
    title: 'What is Health Checking?',
    body: 'Active checks: the control plane polls every backend /health endpoint (and the entry LB polls every gateway) every 3 seconds. Passive checks: gateways open a small circuit breaker after repeated forwarding errors. A failed instance stops receiving traffic until its health check passes again.',
  },
  {
    title: 'What is Redis Pub/Sub?',
    body: 'A message broadcast channel. When the routing configuration changes, the control plane publishes the new version on a Redis channel; all three gateway processes are subscribed and update themselves instantly. This is how independent processes stay synchronized without restarting - and why routing state is never kept only in the browser.',
  },
  {
    title: 'What is MongoDB used for?',
    body: 'Durable storage: every version of the routing configuration, the audit history of who changed what, every processed request log, and the demo user accounts. The request path never blocks on MongoDB - gateways stream logs to the control plane over Redis, which batches inserts once per second.',
  },
  {
    title: 'How does the complete request lifecycle work?',
    body: '1) You send GET /api/users from the Traffic Generator to :3000. 2) The entry LB picks a healthy gateway. 3) The gateway matches the path against its in-memory routing table. 4) The JWT middleware validates the token if the route requires auth. 5) Round-robin picks a healthy backend instance. 6) The reverse proxy forwards method, path, headers and body. 7) The backend responds; the proxy relays it. 8) Metrics and a request log record are produced asynchronously (Redis -> control plane -> MongoDB -> your browser over Socket.IO).',
  },
];

const DEMO_STEPS = [
  'Send a normal request: Traffic Generator -> GET /api/products, 5 requests, Normal speed. Watch gateway cards and logs.',
  'JWT failure: Quick Scenario 2 (Missing JWT) and 3 (Invalid JWT) on /api/users - both appear as 401 in logs.',
  'Successful authenticated request: Login (admin/admin123), set Authentication to "Valid JWT", send 5 requests - all 200.',
  'Dynamic route modification: Configuration page -> edit /api/products/* target to "orders" -> Apply. Send /api/products requests - the Order Service answers.',
  'Configuration synchronization: notice the version badge bump and the toast "synced to all gateways"; all three gateways show the same version in a moment.',
  'Load balancing: restore the products route, send 20 GET /api/products - requests split between :4002 and :4005 (see backend cards).',
  'Backend failure: Quick Scenario 6 (or Fail :4002 on the Product card) - all traffic moves to the other instance.',
  'Gateway failure: "Simulate Failure" on Gateway 2 - the entry LB routes only to Gateways 1 and 3.',
  'Recovery: "Recover" the failed instances - they rejoin the round-robin after the next health check.',
  'Monitoring: review the System Overview chart and the Request Logs table; everything you saw was measured, never faked.',
];

export default function GuidePage() {
  return (
    <div className="guide-page">
      <section className="card">
        <div className="card-head"><h2>Architecture</h2></div>
        <pre className="diagram">{`                                  +---------------------+
                                  |    Browser (5173)   |
                                  |   EdgeGate Web UI   |
                                  +----------+----------+
                                             |  real HTTP traffic + Socket.IO
                                             v
                                  +----------+----------+
                                  |  Entry Load Balancer|
                                  |       (:3000)       |
                                  +----------+----------+
                          round-robin, healthy gateways only
             +---------------------+------+----------------------+
             v                     v                      v
      +-------------+       +-------------+        +-------------+
      | Gateway 1   |       | Gateway 2   |        | Gateway 3   |
      | (:3001)     |       | (:3002)     |        | (:3003)     |
      +------+------+       +------+------+        +------+------+
             | JWT auth + dynamic routing + reverse proxy
             | (config kept in sync via Redis Pub/Sub)
      +------+---------------------+----------------------+
      v                      v                            v
+-----------+ +-----------+ +-----------+  (2 instances each)
| User Svc  | | Product   | | Order Svc |
| 4001/4004 | | 4002/4005 | | 4003/4006 |
+-----------+ +-----------+ +-----------+

MongoDB (:27017)  -> routing versions, audit, request logs, users
Redis (:6379)     -> config Pub/Sub, log/metric streaming
Control plane(5000) -> REST + Socket.IO live monitoring`}</pre>
      </section>

      <section className="card">
        <div className="card-head"><h2>Core Concepts</h2></div>
        <div className="concept-grid">
          {CONCEPTS.map((c) => (
            <div className="concept" key={c.title}>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Guided Demonstration Workflow</h2>
          <Link className="btn btn-primary" to="/">Open Virtual Lab</Link>
        </div>
        <ol className="demo-steps">
          {DEMO_STEPS.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      </section>
    </div>
  );
}

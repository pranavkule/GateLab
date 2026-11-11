# EdgeGate — Architecture & Request Lifecycle

## Components

### 1. Entry-point load balancer (`:3000`, own OS process)
First hop for every client request. Maintains a round-robin cursor over **healthy
gateways only**. Health comes from three sources:
- **active**: polls `/gateway-health` on each gateway every 3 s,
- **passive**: two consecutive forwarding failures open a local circuit,
- **instant**: `edgegate:gateway-cmd` Pub/Sub events (simulation).

### 2. Gateway instances (`:3001-3003`, one OS process each)
Each gateway is a fully independent Node process (spawned by `cluster` in
`backend/index.js`) that owns:
- **its own in-memory routing table** (frozen object references, replaced atomically
  on config updates — a request can never see a half-updated table),
- its own metrics counters and its own round-robin cursors per service.

Request pipeline: **CORS → JWT middleware → universal request logger → dynamic route
match → healthy-instance selection → reverse proxy → response + async log publish**.

### 3. Microservices (`:4001-4006`, two instances per service)
Simple Express services (users/products/orders). Each exposes data endpoints,
`/health` (with real request counts) and accepts runtime simulation commands:
`down` (health + traffic both refuse → real unavailability), `latency`,
`errors`. Distinguishing note: simulated failure is a refusal inside the process,
not a crash — recovery is instant.

### 4. Control plane (`:5000`, in the primary process)
- REST API (config CRUD + apply, logs, simulation, reset, status).
- **Socket.IO** server pushing: `metrics`, `gateway-health`, `backend-health`,
  `request-log`, `config-update`, `logs-cleared`.
- **Log batcher**: gateway log records arrive over Redis `edgegate:logs`; the batcher
  inserts them into MongoDB once per second (never blocking the request path).
- **Metric aggregator**: 1 s snapshots from every process → system overview +
  60 s throughput/latency history (all real values).
- **Active health checker**: polls every backend `/health` and gateway
  `/gateway-health`, caches latency + request counts, broadcasts on change.

### 5. Auth service (`:5001`)
Signs HS256 JWTs (`sub`, `role`, `iat`, `exp`) with a secret from environment
variables. Provides login, demo token generation (valid/expired/invalid) and
verification. The secret is shared only with the gateways (via env) and is never sent
to the frontend.

### 6. Configuration manager (control plane + Pub/Sub)
`PUT /api/config` → **validate** (paths, targets, booleans, duplicates) → **persist**
new version row in MongoDB + **audit record** → **publish full snapshot** on
`edgegate:config`. Every gateway subscribed replaces its routing table with one
assignment (atomic). New gateways additionally fetch the latest version over HTTP at
startup (sync mechanism) and retry until the control plane is reachable.

### 7. Databases
- **MongoDB**: versioned routing configs, audit history, request logs (indexed by
  timestamp), demo users.
- **Redis**: pure Pub/Sub transport for config/log/metric/command/reset channels.
  It is deliberately not used as a Mongo replacement.

## Complete request lifecycle (GET /api/users with JWT)

1. Browser/generator sends `GET http://localhost:3000/api/users` + `Authorization: Bearer …`.
2. Entry LB: healthy gateway list → round-robin → Gateway 2 (`:3002`).
3. Gateway: JWT middleware → signature, expiry and required claims verified → `req.user` set;
   auth context forwarded upstream as `x-auth-user`.
4. Route match: `/api/users/*` → User Service, auth required.
5. Instance selection: healthy instances `4001, 4004` → round-robin → `4004`.
6. Reverse proxy: keep-alive socket, forwards method/path/headers/body, streams the
   response back (timeout 8 s → `504`; connection refused → retry once on another
   instance, then `502`).
7. Response relays to the client with `x-gateway`, `x-service`, `x-instance` headers.
8. Asynchronously: log record → Redis → control plane → MongoDB batch insert →
   Socket.IO → Request Logs table. Metrics counters update within 1 s.

## Failure handling model

| Failure | Detection | Client impact | Recovery |
|---|---|---|---|
| Backend instance down (simulated) | Pub/Sub cmd + active check + passive errors | none (other instance serves) | Recover cmd → health check passes → rejoin round-robin |
| All instances of a service down | gateway check | `503` with clear message | recover any instance |
| Gateway down (simulated) | Pub/Sub cmd + entry LB poll | none (other gateways serve) | Recover cmd |
| Upstream timeout | proxy timeout 8 s | `504` once, then instance excluded | instance health check |
| Invalid route | routing table miss | `404` clean JSON | fix configuration |
| Missing/invalid/expired JWT | JWT middleware | `401` with reason | login again |

## Design decisions worth remembering (viva points)

- **Process isolation with `cluster`**: "gateways must not share mutable routing
  state" — they literally cannot; each worker has its own module instances.
- **Atomic config replacement**: the new table is built fully, frozen, then one
  reference swap; in-flight requests keep the old table.
- **Keep-alive proxy agents**: fresh TCP + DNS per request capped throughput at
  ~350 req/s; pooled agents restored ~500+ req/s through two LB layers.
- **Async log persistence**: Redis channel + 1 s batch inserts keep MongoDB out of
  the request lifecycle.
- **Two LB layers with distinct cursors**: gateway selection (entry LB) and backend
  selection (inside each gateway) are independent round-robin selectors.

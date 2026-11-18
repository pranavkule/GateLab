# EdgeGate — Architecture & Request Lifecycle

## Components

### 1. Entry-point load balancer (`:3010`, own OS process)
First hop for every client request. Maintains a round-robin cursor over **healthy
gateways only**. Health comes from three sources:
- **active**: polls `/gateway-health` on each gateway every 3 s,
- **passive**: two consecutive forwarding failures open a local circuit,
- **instant**: `edgegate:gateway-cmd` Pub/Sub events (simulation).

### 2. Gateway instances (`:3011-3013`, one OS process each)
Each gateway is a fully independent Node process (spawned by `cluster` in
`backend/index.js`) that owns:
- **its own in-memory routing table** (frozen object references, replaced atomically
  on config updates — a request can never see a half-updated table),
- its own metrics counters and its own round-robin cursors per service.

Request pipeline: **CORS → JWT middleware → rate-limit middleware → universal request
logger → dynamic route match → eligible-instance selection (not admin-hard-down,
circuit not OPEN) → reverse proxy → response + async log publish**.

### 3. Microservices (`:4011-4016`, two instances per service)
Simple Express services (users/products/orders). Each exposes data endpoints,
`/health` (with real request counts) and accepts runtime simulation commands:
`down` (health + traffic both refuse → real unavailability), `latency`,
`errors`. Distinguishing note: simulated failure is a refusal inside the process,
not a crash — recovery is instant.

### 4. Control plane (`:5010`, in the primary process)
- REST API (config CRUD + apply, logs, simulation, reset, status).
- **Socket.IO** server pushing: `metrics`, `gateway-health`, `backend-health`,
  `request-log`, `config-update`, `logs-cleared`.
- **Log batcher**: gateway log records arrive over Redis `edgegate:logs`; the batcher
  inserts them into MongoDB once per second (never blocking the request path).
- **Metric aggregator**: 1 s snapshots from every process → system overview +
  60 s throughput/latency history (all real values).
- **Active health checker**: polls every backend `/health` and gateway
  `/gateway-health`, caches latency + request counts, broadcasts on change.
- REST monitoring and traffic simulation require a signed, unexpired
  administrator or student JWT. Configuration, configuration history, reset,
  fault injection, and log clearing require the administrator role. Socket.IO
  accepts both lab roles and an allowed browser origin. `/health` returns only a
  minimal status; gateways can read only `/api/config/latest` without a user
  token for startup bootstrap. Customer JWTs stay store-only.

### 5. Auth service (`:5011`)
Signs HS256 JWTs (`sub`, `role`, `iat`, `exp`) with a required environment
secret shared by Auth, Gateway, and Product Service processes. The secret has
no source-code fallback and is never sent to the frontend. Customer
registration/login remain available; demo login, demo token, and plaintext
verification endpoints exist only outside production.

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
  It is deliberately not used as a Mongo replacement. The exceptions are shared
  mutable state where Redis IS the data store: the P2.4 rate-limit namespace
  (`edgegate:rl:*`) and the P2.5.1 circuit-breaker state (`edgegate:cb:*`).

## 8. Rate limiting (P2.4, shared fixed window)
- **Configuration**: every route optionally carries `rateLimit: { limit, windowMs }`
  (`limit` positive integer, `windowMs` 1000-3600000 ms). Absent/null = unlimited,
  so existing saved configurations and the default routes are unaffected. Limits
  are edited on the Configuration page and flow through the SAME pipeline as
  routing rules: validate → persist (version++) → audit → publish full snapshot
  on `edgegate:config` → atomic in-memory replacement in every gateway.
- **Enforcement**: a gateway middleware mounted after the JWT middleware and
  before backend selection. Missing/invalid JWTs still get the existing `401`;
  rate limiting then applies to requests that reached route handling, and
  public routes are rate-limited by IP.
- **Identity**: on authenticated routes the verified JWT subject (`req.user.sub`)
  — never a client-supplied header; on public routes the trusted client IP.
  The entry load balancer OVERWRITES `X-Forwarded-For` with the connecting
  socket address (normalized: `::ffff:` and `::1` collapse to IPv4), so the
  single-hop XFF value seen by the gateway cannot be forged by clients. Gateways
  are loopback-only and never publicly reachable.
- **Algorithm**: fixed window in Redis via one Lua round trip per limited
  request: `INCR key` + `PEXPIRE key windowMs` when the counter is new + `PTTL`.
  The key is `edgegate:rl:v<configVersion>:<routeId>:<identity>`, so all three
  gateway instances share ONE budget per (version, route, client) and applying a
  new configuration version starts everyone with a clean budget (stale windows
  expire by TTL). `POST /api/reset` flushes the whole namespace.
- **429 behavior**: over-limit requests are answered by the gateway itself with
  `429 {"error":"rate_limited", retryAfterMs}` + `Retry-After` seconds (from the
  window TTL) and `X-RateLimit-Limit/Remaining/Reset` headers. They are logged
  (`rateLimited: true`, `backendInstance: none`), filterable in `/api/logs`
  (`status=rate_limited` or `status=429`), and counted in a dedicated
  `rateLimited` metric that flows into gateway snapshots, the entry-LB
  snapshot, the control-plane overview and the System Overview card. A 429 is
  never counted as success or as a 5xx failure.
- **Fail-open trade-off**: if Redis is unavailable the middleware allows the
  request and logs a throttled warning. This keeps the lab (and, in production,
  the storefront) available during a Redis outage at the cost of temporarily
  unenforced limits — a deliberate availability-over-strictness decision.
  The Redis connection is persistent (one per gateway process), so there is no
  per-request connection cost and the hot-path overhead is one local round trip.

## 9. Circuit breaker (P2.5.1, shared Redis state per backend instance)

- **Scope**: every BACKEND INSTANCE gets its own circuit, keyed
  `edgegate:cb:<backendPort>` (a hash: `state`, `openedAt`, `failures`,
  `probes`). All gateway processes share the state, so a circuit opened by
  one gateway is honoured by all of them. Circuit state lives in Redis (not
  Pub/Sub) for the same reason as the P2.4 counters: shared mutable state is
  the entire point.
- **States**: `CLOSED` (normal traffic, consecutive failures counted) →
  `OPEN` after `CB_FAILURE_THRESHOLD` consecutive failures (default 5) →
  `HALF-OPEN` after the `CB_COOLDOWN_MS` cooldown (default 10 s) admits at
  most `CB_HALF_OPEN_PROBES` test requests (default 1) → a successful probe
  `CLOSES` the circuit; a failed probe reopens it with a fresh cooldown.
- **Atomicity**: each operation is a single Lua script — `admit`
  (eligibility + OPEN→HALF-OPEN transition + probe reservation in one round
  trip), `recordFailure`, `recordSuccess`, plus a read-only `peek`. Because
  Redis executes scripts atomically, concurrent gateways can never exceed
  the probe limit.
- **Gateway integration**: before round-robin selection the gateway filters
  out instances whose circuit is OPEN (read-only peek — never consumes a
  probe slot), so blocked candidates do not advance the round-robin cursor.
  The selected candidate is then ADMITTED just before forwarding. If no
  eligible candidate remains, the gateway answers `503 {"error":
  "circuit_open"}` with a `Retry-After` header and an `x-edgegate-circuit:
  open` response header.
- **Failure classification**: connection refused/unreachable, upstream
  timeout and upstream HTTP 5xx count as failures (consecutive semantics —
  any 2xx/3xx/4xx outcome resets the counter). Gateway-generated responses
  (401/404/429/503) never touch the circuit. A circuit-generated 503 is
  never counted as a backend failure.
- **Availability model separation** (registry no longer marks instances
  unhealthy on forwarding failures):
  - *administrative hard-down*: Fail/Recover commands only
    (`registry.backends[port].hardDown`);
  - *active health checks*: control-plane monitoring only, they NEVER open
    or close a circuit;
  - *circuit breaker*: Redis state, driven only by real proxied traffic.
  Only a successful HALF-OPEN probe closes an OPEN circuit. Manual Recover
  restores the backend AND deletes its circuit key immediately (both in the
  control plane and on every gateway receiving the `up` command).
- **Entry LB compatibility**: a gateway 503 carrying `x-edgegate-circuit:
  open` is a healthy gateway's backend-circuit decision, so the entry LB
  does not mark the gateway unhealthy (headers relayed by the proxy are
  readable via the captured `res.proxiedResponse`; Node's `writeHead` object
  headers are not visible to `getHeader`). Genuine gateway 503s keep the
  existing passive marking.
- **TTL + fail-open**: every write refreshes a safety TTL (≥ 60 s), so
  circuit state never outlives its usefulness after a crash. If Redis is
  unavailable, the breaker fails OPEN (requests pass through, throttled
  warning) — a Redis outage must never take the gateway down.
- **Observability**: `/gateway-health` and the 1 s gateway metric snapshots
  include a `circuits` map (state, failures, probes, retryAfterMs per
  instance). Lab Reset flushes the whole `edgegate:cb:*` namespace.
- **Dashboard (P2.5.2)**: the browser consumes exactly that existing surface —
  no new backend endpoints and no duplicated breaker logic. The `useLab` hook
  takes the `circuits` map from the gateway snapshots inside the Socket.IO
  `metrics` event (all gateways report the same shared Redis state); the
  Circuit Breakers card renders CLOSED/OPEN/HALF-OPEN badges with failure
  counts, probe slots and remaining cooldown, the Backends rows add a circuit
  badge next to (separate from) the health dot, System Overview shows a
  "Circuits Open" counter, and Quick Scenario 8 replays the whole state machine
  with real traffic: 100% injected upstream errors → circuits OPEN → blocked
  `503 circuit_open` requests → cooldown → HALF-OPEN probes → automatic close.

## Complete request lifecycle (GET /api/users with JWT)

1. Browser/generator sends `GET http://localhost:3010/api/users` + `Authorization: Bearer …`.
2. Entry LB: healthy gateway list → round-robin → Gateway 2 (`:3012`).
3. Gateway: JWT middleware → signature, expiry and required claims verified → `req.user` set;
   auth context forwarded upstream as `x-auth-user`.
4. Route match: `/api/users/*` → User Service, auth required.
5. Instance selection: healthy instances `4011, 4014` → round-robin → `4014`.
6. Reverse proxy: keep-alive socket, forwards method/path/headers/body, streams the
   response back (timeout 8 s → `504`; connection refused → retry once on another
   instance, then `502`).
7. Response relays to the client with `x-gateway`, `x-service`, `x-instance` headers.
8. Asynchronously: log record → Redis → control plane → MongoDB batch insert →
   Socket.IO → Request Logs table. Metrics counters update within 1 s.

## Security boundaries

- The gateway removes any client-supplied `x-auth-user` header before route
  handling. On protected routes it derives a new identity header only after
  verifying the JWT. User and Order Services trust that header only from the
  co-located Gateway process.
- Gateway and backend service listeners bind to loopback; MongoDB and Redis
  Compose host ports bind to loopback as well. Production deployment must keep
  service/database ports on private networks and expose only a reverse proxy.
- Browser origins are restricted by `ALLOWED_ORIGINS`; development defaults
  allow the local Vite origin. CORS is not authentication: Control Plane REST
  operations and Socket.IO sessions separately require an administrator or
  student JWT, with administrator authorization on configuration and fault
  controls.
- The single-node MongoDB replica set remains unauthenticated by default for
  local development. Production connection URLs must include credentials.
  Adding credentials to an existing Mongo volume requires provisioning users
  before enabling authenticated startup.

## Production Docker packaging boundaries

The project keeps its existing process architecture when running in Docker: the
backend container hosts the same Node cluster as local development, and the
frontend container serves the built app through Nginx. Public browser traffic is
received only on port 80 and routed internally to the correct service:

- `/:` static React app and SPA fallback
- `/auth/*` -> Auth Service (`:5011`)
- `/api/config*`, `/api/status`, `/api/logs`, `/api/reset`, `/api/backend/*`, `/api/gateway/*`, `/api/demo-token` -> Control Plane (`:5010`)
- `/api/*` -> Entry Load Balancer (`:3010`) for storefront, catalog, orders, and profile traffic
- `/socket.io/*` -> Control Plane Socket.IO (`:5010`)

The browser therefore uses the same-origin URL in production and never calls the
internal service ports directly. Docker Compose keeps MongoDB and Redis on the
internal bridge network, with only the frontend service published to the host.

## Failure handling model

| Failure | Detection | Client impact | Recovery |
|---|---|---|---|
| Backend instance down (simulated) | Pub/Sub cmd + active check + passive errors | none (other instance serves) | Recover cmd → health check passes → rejoin round-robin |
| Worker exits or fails to start | cluster supervisor | only that worker is unavailable | exponential backoff and a per-worker restart budget; manual intervention after exhaustion; SIGTERM cleanup with bounded force-stop |
| Backend MongoDB connection unavailable | service `/health` | instance excluded from gateway selection; peer instance remains available | MongoDB reconnect restores readiness; failed startup is retried by the supervisor |
| All instances of a service down | gateway check | `503` with clear message | recover any instance |
| Gateway down (simulated) | Pub/Sub cmd + entry LB poll | none (other gateways serve) | Recover cmd |
| Upstream timeout | proxy timeout 8 s | `504` once, then instance excluded | instance health check |
| Backend circuit OPEN (P2.5.1) | threshold consecutive failures in shared Redis | `503 circuit_open` + `Retry-After` when no eligible instance remains | cooldown → HALF-OPEN probe success closes; manual Recover resets |
| Invalid route | routing table miss | `404` clean JSON | fix configuration |
| Missing/invalid/expired JWT | JWT middleware | `401` with reason | login again |
| Per-route rate limit exceeded | shared Redis counter (fixed window) | `429` + `Retry-After` header | wait for the window or Lab Reset |

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




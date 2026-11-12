# EdgeGate â€” Dynamic L7 API Gateway & Reverse Proxy Virtual Lab

EdgeGate is a locally runnable system-design simulator that demonstrates how a modern
**Layer 7 API gateway** works end to end: dynamic routing, JWT authentication, reverse
proxying, two layers of load balancing, health checking, failure simulation and live
observability â€” all with **real** HTTP traffic, real metrics and real persistence
(never fake numbers in the UI).

## Objectives

1. High-performance L7 API gateway (3 independent instances, atomic dynamic routing).
2. Reverse proxying with error mapping and timeouts.
3. JWT authentication (login/verify, missing/invalid/expired handling).
4. Gateway-level and backend-level load balancing (round-robin, healthy-only).
5. Active + passive health checking and failure simulation/recovery.
6. Runtime routing updates via **Redis Pub/Sub** (no gateway restarts).
7. Persistence and auditability with **MongoDB** (config versions, audit, request logs).
8. Real-time monitoring dashboard (React + Socket.IO).

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, React Router, Recharts, Lucide icons, Socket.IO client |
| Backend | Node.js (cluster for process isolation), Express, `http.request`-based reverse proxy, jsonwebtoken, Socket.IO, ioredis |
| Storage | MongoDB (Mongoose), Redis (Pub/Sub only â€” never used as a Mongo substitute) |
| Infra | Docker Compose (mongo:7, redis:7) |
| Testing | Jest, Supertest, autocannon |

## System architecture

```
                                  +---------------------+
                                  |    Browser (5174)   |
                                  |   EdgeGate Web UI   |
                                  +----------+----------+
                                             |  real HTTP traffic + Socket.IO
                                             v
                                  +----------+----------+
                                  |  Entry Load Balancer|
                                  |       (:3010)       |
                                  +----------+----------+
                          round-robin, healthy gateways only
             +---------------------+------+----------------------+
             v                     v                      v
      +-------------+       +-------------+        +-------------+
      | Gateway 1   |       | Gateway 2   |        | Gateway 3   |
      | (:3011)     |       | (:3012)     |        | (:3013)     |
      +------+------+       +------+------+        +------+------+
             | JWT auth + dynamic routing + reverse proxy
             | (routing tables kept in sync via Redis Pub/Sub)
      +------+---------------------+----------------------+
      v                      v                            v
+-----------+ +-------------+ +-----------+   (2 instances each)
| User Svc  | | Product Svc | | Order Svc |
| 4011/4014 | | 4002/4005   | | 4013/4016 |
+-----------+ +-------------+ +-----------+

MongoDB (:27019)   -> routing config versions, audit history, request logs, users
Redis (:6381)      -> config Pub/Sub, async log/metric streaming
Control plane (5010)-> REST API + Socket.IO live monitoring + health checker
Auth service(5011) -> JWT login / token / verify
```

Component details and the full request lifecycle: [docs/architecture.md](docs/architecture.md)

## Folder structure

```
backend/
  index.js              cluster launcher: control plane + auth + 10 worker processes
  controlPlane.js       REST + Socket.IO + log batcher + metric aggregator
  registry.js           per-process runtime state (routing table, health, metrics)
  db.js  redis.js       MongoDB + Redis connection handling
  config/               service catalog, default routes, config manager (validate/persist/publish)
  auth/                 JWT helpers + auth service (:5011)
  gateway/              gateway instance, entry load balancer
  middleware/           JWT verification middleware
  proxy/                reverse proxy implementation
  loadBalancer/         round-robin selector (one cursor per service)
  services/             microservice instance factory (6 instances)
  health/               active health checker
  models/               Mongoose schemas + indexes
  scripts/seed.js       initial routing config + demo user
frontend/
  src/components/       Navbar, SystemOverview, Gateways, Backends, TrafficGenerator, RequestLogs
  src/pages/            LabPage, ConfigPage, GuidePage
  src/services/         REST client, Socket.IO client
  src/hooks/useLab.js   live state hook (REST bootstrap + Socket.IO streams)
  src/styles/lab.css
tests/                  Jest + Supertest + autocannon (12 acceptance scenarios)
scripts/stop.ps1        frees all lab ports
docker-compose.yml      mongo:7 + redis:7
```

## Installation

```bash
npm run install:all     # installs root + frontend dependencies
npm run db:up           # starts MongoDB + Redis via Docker Compose
npm run seed            # seeds routing config v1 + demo user (idempotent)
```

## Startup

```bash
npm run dev             # backend (11 processes via cluster) + frontend (Vite)
```

Open **http://localhost:5174**.

Stop everything (including the dev processes started outside the terminal):

```bash
npm run stop            # frees ports 3010-3013, 4011-4016, 5010, 5011, 5174 (and the isolated test ports 14001-14102, 15000-15001)
npm run db:down         # stops MongoDB + Redis containers
```

## Running two EdgeGate copies side by side

This copy is configured to run **independently** of another EdgeGate instance on the
same machine (which owns the classic ports 3000-3003, 4001-4006, 5000, 5001, 5173,
27017, 6379). Every port is configurable — nothing is hardcoded:

| Component | This copy | Other copy (do not touch) |
|---|---|---|
| Entry LB | :3010 | :3000 |
| Gateways | :3011-3013 | :3001-3003 |
| Backend instances | :4011-4016 | :4001-4006 |
| Control plane / Auth | :5010 / :5011 | :5000 / :5001 |
| Frontend (Vite) | :5174 | :5173 |
| MongoDB (Docker) | host 27019 → container 27017 | host 27017 |
| Redis (Docker) | host 6381 → container 6379 | host 6379 |

Both copies need their own containers: this copy's compose uses container names
`edgegate2-mongo` / `edgegate2-redis` and volume `edgegate2_mongo_data`, so
`docker compose up` here will never touch the other copy's containers or data.
To run both: start the other project normally, then run this project's commands below.

## Environment configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `ENTRY_LB_PORT` | 3010 | Entry-point load balancer |
| `GATEWAY_PORTS` | 3011,3012,3013 | Gateway instances |
| `CONTROL_PLANE_PORT` | 5010 | REST + Socket.IO |
| `AUTH_PORT` | 5011 | Auth service |
| `BACKEND_INSTANCES` | 4011:users,... | port:serviceKey list (2 per service) |
| `MONGO_URI` | mongodb://127.0.0.1:27019/edgegate | MongoDB connection (host 27019 -> container 27017) |
| `REDIS_URL` | redis://localhost:6381 | Redis connection, Pub/Sub only (host 6381 -> container 6379) |
| `JWT_SECRET` | dev value | JWT signing secret (server-only) |
| `JWT_EXPIRES_IN` | 1h | Token lifetime |
| `DEMO_USER` / `DEMO_PASSWORD` | admin / admin123 | Seeded demo login |
| `HEALTH_CHECK_INTERVAL` | 3000 ms | Active health-check interval |
| `PROXY_TIMEOUT` | 8000 ms | Upstream timeout |

The frontend reads its backend ports from `frontend/.env` (Vite env): `VITE_PORT` (5174),
`VITE_CONTROL_PLANE_PORT` (5010), `VITE_AUTH_PORT` (5011), `VITE_ENTRY_LB_PORT` (3010).
If you change backend ports in the root `.env`, update `frontend/.env` to match.

A dev-only `.env` is committed for convenience â€” replace `JWT_SECRET` for anything non-demo.

> Note: on Windows machines where both a local MongoDB service and Docker publish port
> 27017, `localhost` can resolve inconsistently between IPv4/IPv6 â€” that is why the
> defaults use `127.0.0.1` for MongoDB and `localhost` for Redis. Adjust if your setup
> differs.

## API endpoint documentation

### Through the gateway (:3010) (traffic path â€” via entry LB :3010)

| Endpoint | Auth | Description |
|---|---|---|
| `GET /api/products` | public | Product Service |
| `GET /api/users` | JWT | User Service (401 without/invalid/expired token) |
| `GET /api/orders` | JWT | Order Service |
| `POST /api/<service>` | per route | Creates data on the target service |
| `GET /gateway-health` (per instance) | - | Gateway self status (also used by the entry LB) |

### Auth service (:5011)

- `POST /auth/login` `{username,password}` â†’ `{token, user}` (demo: admin/admin123)
- `POST /auth/token` `{type: valid|expired|invalid}` â†’ demo token for the lab
- `POST /auth/verify` `{token}` â†’ `{valid, payload|error}`
- `GET /auth/me` (Bearer) â†’ payload

### Control plane (:5010)

- `GET /api/status` â€” health snapshots of gateways + backends, service catalog
- `GET /api/config/latest` / `PUT /api/config` `{routes}` â€” read / validate / persist / publish routing config
- `GET /api/config/history` â€” config versions + audit trail
- `GET /api/logs?search=&status=&page=&limit=` â€” request logs (MongoDB)
- `DELETE /api/logs` â€” clear request logs
- `POST /api/backend/:port/fail|recover|latency|errors` â€” failure/latency/error simulation
- `POST /api/gateway/:port/fail|recover` â€” gateway failure simulation
- `POST /api/reset` â€” reset lab counters (config history preserved)
- `GET /api/demo-token?type=valid|expired|invalid`

## JWT testing instructions

1. In the UI: **Traffic Generator â†’ Demo Login** (admin/admin123) â†’ set Authentication to "Valid JWT".
2. Or via REST:
   ```bash
   curl -X POST http://localhost:5011/auth/login -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"admin123\"}"
   curl http://localhost:3010/api/users -H "Authorization: Bearer <token>"
   ```
   Use `type=expired` / `type=invalid` demo tokens to see the 401 variants.
3. No secrets are ever sent to the browser â€” tokens are produced by the auth service/control plane.

## Dynamic routing demonstration

1. Open **Configuration** page â†’ edit `/api/products/*` â†’ Target Service: `orders` â†’ **Apply Configuration**.
2. Version badge increments, change is audited, all three gateways reload live via Redis Pub/Sub (check gateway cards).
3. Send `GET /api/products` â€” the **Order Service** answers. No gateway was restarted.

## Load balancing demonstration

1. Send 20 `GET /api/products` requests (Fast speed).
2. Backend cards show requests split across `:4012` and `:4015` (round-robin, ~10/10).
3. Entry LB distributes across gateways 1â€“3 (visible in request logs' Gateway column).

## Failure simulation demonstration

1. **Backend failure**: Fail `:4012` â†’ all new traffic goes to `:4015` â†’ Recover restores round-robin.
2. **Gateway failure**: Simulate Failure on Gateway 2 â†’ entry LB routes only to Gateways 1 & 3 â†’ Recover.
3. **Degradation**: Simulate Latency (400 ms) or Simulate Errors (40%) on an instance â€” reflected in real latency/error metrics.
4. If ALL instances of a service are down the gateway returns `503 Service Unavailable`.
5. Failure states are real: the instance refuses traffic (`503`), health checks report it down, LB excludes it, logs record it.

## MongoDB & Redis usage

- **MongoDB**: `routeconfigs` (versioned routing tables), `configaudits` (who changed what when), `requestlogs` (every processed request, batch-inserted), `users` (demo login).
- **Redis Pub/Sub channels**: `edgegate:config` (routing updates), `edgegate:logs` (async log stream), `edgegate:metrics` (1 s metric snapshots), `edgegate:backend-cmd` / `edgegate:gateway-cmd` (failure commands), `edgegate:reset`.
- Routing state is never kept only in the browser; gateways each own an in-memory copy kept in sync over Pub/Sub and replaced atomically.

## Automated testing

```bash
npm run db:up        # tests need MongoDB + Redis
npm test             # 17 tests: JWT (1-4), dynamic routing (5,6), LB (7),
                     # failure/recovery (8-10), logs (11), validation edge cases
npm run test:performance   # autocannon load through the entry LB (scenario 12)
```

The tests boot a dedicated mini-stack on ports 14001-14102/15000-15001 with a separate
`edgegate_test` database, so they never collide with the running dev stack.

## Performance testing

`npm run test:performance` runs autocannon for 3 s through the entry load balancer and
prints the **measured** throughput, average latency and error count, asserting 0 errors.
Reference result on a mid-range Windows laptop: ~475 req/s, ~21 ms average latency, 0 errors.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Failed to start EdgeGate` / Mongo timeouts | `npm run db:up`, wait a few seconds, retry |
| Redis errors | `docker ps` â€” the Redis container must be up on 6381 |
| Port already in use | `npm run stop` |
| Tests fail to boot | The test stack needs the same DB containers; check `edgegate_test` is creatable |
| Dashboard shows "Offline" | Control plane (:5010) not running â€” restart `npm run dev` |
| Routing change not visible | Check the version badge â€” each Apply creates a new version and broadcasts it |

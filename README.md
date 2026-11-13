# EdgeGate: Dynamic L7 API Gateway & Reverse Proxy Virtual Lab

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
| 4011/4014 | | 4012/4015   | | 4013/4016 |
+-----------+ +-------------+ +-----------+

MongoDB -> routing config versions, audit history, request logs, users, products, orders
Redis    -> config Pub/Sub, async log/metric streaming
Local development host ports: MongoDB 127.0.0.1:27018, Redis 127.0.0.1:6380
Production: MongoDB Atlas gatelab.bvnyegl.mongodb.net (SRV), Redis redis:6379 (not host-published)
Control plane (5010)-> REST API + Socket.IO live monitoring + health checker
Auth service(5011) -> JWT login / token / verify
```

Component details and the full request lifecycle: [docs/architecture.md](docs/architecture.md)

### Runtime responsibilities

| Component | Responsibility |
|---|---|
| Entry load balancer (:3010) | Sends requests to healthy gateway instances using round-robin selection. |
| Gateways (:3011-3013) | Verify JWTs on protected routes, apply the current dynamic route table, select healthy service instances, and proxy requests. |
| User Service (:4011, :4014) | Register/login support through Auth Service, customer profile reads/updates, and admin user lookup; profiles are stored in MongoDB. |
| Product Service (:4012, :4015) | Public catalog/search/filtering and admin product management; products and inventory are stored in MongoDB. |
| Order Service (:4013, :4016) | Customer orders/history and admin order management; transactions protect inventory deduction, order creation, and cancellation restoration. |
| Auth Service (:5011) | Customer registration/login and development-only demo login; issues JWTs without exposing the signing secret to the browser. |
| Control Plane (:5010) | Administrator-protected configuration, fault controls, logs/metrics, health checks, and Socket.IO updates for the Virtual Lab. |
| MongoDB / Redis | MongoDB persists application/configuration data; Redis carries Pub/Sub snapshots, commands, logs, and metrics. |

## Folder structure

```
backend/
  index.js              cluster launcher: control plane + auth + 10 worker processes
  controlPlane.js       REST + Socket.IO + log batcher + metric aggregator
  registry.js           per-process runtime state (routing table, health, metrics)
  db.js  redis.js       MongoDB + Redis connection handling
  config/               service catalog, default routes, config manager (validate/persist/publish)
  auth/                 JWT helpers + auth service (:5011)
  security/             shared HTTP CORS policy
  gateway/              gateway instance, entry load balancer
  middleware/           JWT verification middleware
  proxy/                reverse proxy implementation
  loadBalancer/         round-robin selector (one cursor per service)
  services/             microservice instance factory (6 instances)
  health/               active health checker
  models/               Mongoose schemas + indexes
  scripts/seed.js       initial routing config + development demo user
  scripts/provisionAdmin.js  interactive first-admin provisioning
frontend/
  src/components/       Navbar, SystemOverview, Gateways, Backends, TrafficGenerator, RequestLogs
  src/pages/            LabPage, ConfigPage, GuidePage
  src/store/            Customer storefront, authentication, cart, checkout, account and admin pages
  src/services/         REST client, Socket.IO client
  src/hooks/useLab.js   live state hook (REST bootstrap + Socket.IO streams)
  src/styles/lab.css
tests/                  Jest + Supertest + autocannon (7 suites, 75 tests)
scripts/stop.ps1        frees all lab ports
docker-compose.yml      mongo:7 + redis:7
```

## Installation

```bash
npm run install:all     # installs root + frontend dependencies
npm run db:up           # starts MongoDB (single-node replica set) + Redis via Docker Compose
npm run seed            # seeds routing config v1 + demo user (idempotent)
npm run seed:data       # seeds e-commerce data: user profiles, products, sample orders (idempotent)
npm run admin:provision # interactively provisions the first administrator
```

`seed` and `seed:data` are development-only and refuse to run when
`NODE_ENV=production`. The administrator provisioning command prompts for
identity details and accepts the password without echoing it; it refuses to
promote an existing customer or create another administrator. Do not copy
development seed accounts into a production database.

Root `.env` and `frontend/.env` are local-only and ignored by Git. Start from
`.env.example`, replace its placeholders locally, and use the same `JWT_SECRET`
for Auth, Gateway, and Product Service processes. Docker production uses a
separate ignored `.env.production` file so local database URLs remain unchanged.
Production startup requires an explicit JWT secret, configured browser origins,
and authenticated MongoDB and Redis connection URLs. The JWT key is never a
frontend/Vite variable.

> **MongoDB transactions note:** the Order Service (P1.4) requires multi-document
> ACID transactions. Local development uses a **single-node replica set** (`rs0`)
> in `docker-compose.dev.yml`, with MongoDB and Redis published only to loopback
> ports `27018` and `6380`. Production uses MongoDB Atlas; its database is not
> stored in a local Docker volume. The `mongo_data` volume belongs to local
> development only and remains managed by `docker-compose.dev.yml`.
> Replica-set health checks do not initialize or migrate a volume. For a fresh
> local volume only, initialize it explicitly after `npm run db:up`:
> `docker compose -f docker-compose.dev.yml exec mongodb mongosh --quiet --port 27018 --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27018'}]})"`.
> For an existing volume, first inspect its state and follow the migration steps
> below; do not run that initialization command against unknown data.

## Startup

```bash
npm run dev             # backend (11 processes via cluster) + frontend (Vite)
```

Open **http://localhost:5174**.

The customer-facing storefront is available at **http://localhost:5174/store**.
It is a separate application area from the Virtual Lab: customers can browse the
live product catalog, register or sign in, manage a local cart, place orders,
and view their profile and order history. Administrators can manage products
and orders from the store's Admin page. Store traffic goes through the entry
load balancer (:3010); registration and customer login use the Auth service
(:5011). Protected service operations still enforce authorization in the
backend.

### Customer workflow

1. Open `/store` to browse the live catalog, search, filter by category, and view product stock.
2. Register at `/store/register`, or sign in at `/store/login`. The local-only
   `npm run seed:data` command creates sample accounts and products; production
   seeding is blocked.
3. Add items to the local cart, adjust quantities, then continue to checkout.
   The Order Service checks current inventory and calculates the final prices and total.
4. Review the confirmation and order ID, then use **My orders** and **My account**
   to see order history and update profile details.
5. Log out to clear the customer session. Checkout, account, and order pages
   require authentication.

No payment is collected. The cart is browser-local; the MongoDB catalog and
Order Service remain authoritative for prices and inventory.

### Admin workflow

Sign in at `/store/login` with an administrator provisioned for the current
database, then open **Admin**. The Products tab
lists active products and supports create, edit, and soft-delete operations.
The Orders tab supports status/customer filters, order details, and valid status
transitions. The Product and Order Services enforce admin authorization; hiding
the admin link in the UI is not the security boundary. Discontinued products
remain in storage for order history, but the current admin API/UI has no restore
operation.

The Virtual Lab and Configuration dashboard require administrator JWTs for
monitoring, configuration, logs, reset, fault injection, and Socket.IO updates.
The development demo login and demo-token endpoints are disabled in production.
Gateways may read the current routing snapshot during startup; the public
`/health` endpoint returns only a minimal readiness status.

Stop everything (including the dev processes started outside the terminal):

```bash
npm run stop            # frees ports 3010-3013, 4011-4016, 5010, 5011, 5174 (and the isolated test ports 14001-14102, 15000-15001)
npm run db:down         # stops MongoDB + Redis containers
```

## Production Docker packaging

The repository now supports a production-style Docker Compose layout that keeps the
existing application architecture intact while moving the public entry point behind
Nginx. The frontend container serves the built React app on port 80; the backend
container runs the existing Node cluster for the entry load balancer, gateways,
internal services, auth service, and control plane. MongoDB is hosted by Atlas;
Redis remains private to the Compose network and is not exposed on the host.

```powershell
# Create a separate production env file if it does not exist, then edit it
# locally. Do not overwrite an existing .env or .env.production.
if (-not (Test-Path .env.production)) { Copy-Item .env.example .env.production }
notepad .env.production

# Required variables in .env.production (see .env.example):
# DOCKER_MONGO_URI, DOCKER_REDIS_URL, REDIS_PASSWORD, JWT_SECRET,
# ALLOWED_ORIGINS

docker compose --env-file .env.production config

docker compose --env-file .env.production build

docker compose --env-file .env.production up -d

docker compose --env-file .env.production ps

docker compose --env-file .env.production logs -f backend frontend
```

Configure Atlas before starting the application:

1. Create a MongoDB Atlas database user with only the permissions the app needs
   for the `edgegate` database. The Atlas account and database user are separate.
2. Set `DOCKER_MONGO_URI` in the ignored `.env.production` to the Atlas SRV
   connection string, with the supplied username/password URL-encoded:
   `mongodb+srv://<url-encoded-user>:<url-encoded-password>@gatelab.bvnyegl.mongodb.net/edgegate?retryWrites=true&w=majority&appName=gatelab`.
   Do not commit this URI or paste credentials into documentation or source.
3. In Atlas **Network Access**, allow the deployment machine's outbound public IP
   address. For EC2, use the instance's stable public egress IP (or NAT gateway
   Elastic IP, if applicable). Avoid allowing `0.0.0.0/0`.
4. Set `DOCKER_REDIS_URL`, `REDIS_PASSWORD`, `JWT_SECRET` (at least 32 bytes),
   and `ALLOWED_ORIGINS` in `.env.production`. The Redis password in the URL
   must match `REDIS_PASSWORD`.

The production Compose file passes `DOCKER_MONGO_URI` to the backend as
`MONGO_URI`; it no longer runs a MongoDB container or declares a production
MongoDB volume. MongoDB root-init variables are not used in production. The
Atlas cluster handles TLS and replica-set discovery through the `mongodb+srv`
URI. Keep local-development `MONGO_URI` and `REDIS_URL` in `.env` separate;
`docker-compose.dev.yml` and its local MongoDB volume remain unchanged.

The browser should communicate through the Nginx origin (`http://localhost`) and
must not hardcode `localhost:3010`, `localhost:5010`, or `localhost:5011` in the
production frontend. Nginx routes customer storefront requests to the gateway,
admin/control-plane actions to the control plane, and auth endpoints to the auth
service. Socket.IO traffic uses the same origin and is proxied to the control-plane
endpoint.

Production Compose explicitly uses `DOCKER_MONGO_URI` and `DOCKER_REDIS_URL`,
never the local `MONGO_URI` and `REDIS_URL`. MongoDB root credentials are only
optional local-development settings. Use fresh Redis/JWT secrets and the actual
browser origin; credentials embedded in connection URLs must be URL-encoded.
Do not reuse any previously disclosed JWT secret or demo password.

Local development continues to use `npm run db:up` and root `.env` values
`MONGO_URI=mongodb://127.0.0.1:27018/edgegate` and
`REDIS_URL=redis://localhost:6380`; it starts only the local database services
from `docker-compose.dev.yml`. It does not initialize MongoDB automatically;
for a fresh local volume, use the one-time initialization command in the
MongoDB note above.

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
| MongoDB (local dev) | host 27018 -> container 27018 | host 27017 |
| Redis (local dev) | host 6380 -> container 6379 | host 6379 |

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
| `MONGO_URI` | mongodb://127.0.0.1:27018/edgegate | Local-development connection via the published host port; production uses Atlas through `DOCKER_MONGO_URI`. |
| `REDIS_URL` | redis://localhost:6380 | Local-development connection via the published host port; production uses `redis:6379` internally. |
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
| `GET /api/products` | public | Product catalog - Product Service business logic (MongoDB, `?category=&search=&page=&limit=`) |
| `GET /api/products/:id` | public | Single active product (404 if unknown/malformed id) |
| `POST /api/products` | JWT (admin) | Create product - Product Service business logic (MongoDB) |
| `PUT /api/products/:id` | JWT (admin) | Update product details (partial updates) |
| `DELETE /api/products/:id` | JWT (admin) | Soft delete (status â†’ `discontinued`; record kept for order history) |
| `GET /api/users` | JWT | User Service (401 without/invalid/expired token) |
| `GET /api/orders` | JWT | Order Service |
| `POST /api/<service>` | per route | Creates data on the target service |
| `GET /api/users/me` | JWT (e-commerce user) | Own profile - User Service business logic (MongoDB) |
| `PUT /api/users/me` | JWT (customer) | Update own profile (role/email/password not editable) |
| `GET /api/users/:id` | JWT (admin) | Admin-only user lookup |
| `GET /gateway-health` (per instance) | - | Gateway self status (also used by the entry LB) |

### Product Service business logic (MongoDB)

Browsing is public; admin operations (create/update/delete) verify the Bearer
JWT **inside the service** using the same shared-secret `verifyToken` the
gateway uses - the gateway deliberately does not evaluate JWTs on public
routes, so no gateway middleware was modified. The role is read from the
verified token payload only (body/query role fields are never trusted).

```bash
# Admin login (seeded profile; also any /auth/register'd admin)
curl -X POST http://localhost:5011/auth/customer-login -H "Content-Type: application/json" -d "{\"email\":\"aarav.mehta@example.com\",\"password\":\"Admin@123\"}"

# Public browsing (active products only; filters/search/pagination)
curl "http://localhost:3010/api/products?category=Audio&search=wireless&page=1&limit=12"
curl http://localhost:3010/api/products/<productId>

# Admin management (Bearer = token from customer-login above)
curl -X POST http://localhost:3010/api/products -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d "{\"name\":\"Wireless Mouse M590\",\"price\":899,\"category\":\"Audio\",\"stock\":25,\"description\":\"Silent-click wireless mouse\"}"
curl -X PUT http://localhost:3010/api/products/<productId> -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d "{\"price\":799,\"stock\":30}"
curl -X DELETE http://localhost:3010/api/products/<productId> -H "Authorization: Bearer <token>"   # soft delete
```

Rules: prices are finite numbers â‰¤ 10,000,000; stock is a non-negative integer
(â‰¤ 1,000,000); product names are unique (409 on duplicates); inventory lives
only in MongoDB and is written atomically, so stock can never go negative.

### Order Service business logic (MongoDB)

Identity and role come from the gateway-verified auth context (`x-auth-user`,
set for the JWT-protected `/api/orders/*` route) - never from client input.
All prices, totals and order status are computed/stored server-side.

| Endpoint | Auth | Description |
|---|---|---|
| `POST /api/orders` | JWT (customer/admin) | Place an order: validates products (active + stock), deducts stock atomically inside a MongoDB transaction, snapshots purchase-time name/price |
| `GET /api/orders` | JWT | Own order history, newest first (`?page=&limit=`) |
| `GET /api/orders/:id` | JWT | Own order; admins may retrieve any order |
| `GET /api/orders/admin` | JWT (admin) | Order list with filters `?status=&user=&page=&limit=` (customers: 403) |
| `PUT /api/orders/admin/:id/status` | JWT (admin) | Validated status transition (short form `PUT /api/orders/:id/status` also accepted) |

> Note: admin order management lives under the **existing** `/api/orders/*`
> gateway route (`/api/orders/admin...`) because `/api/admin/*` has no gateway
> route and the routing config was not modified in this phase.

```bash
# Customer login
curl -X POST http://localhost:5011/auth/customer-login -H "Content-Type: application/json" -d "{\"email\":\"diya.sharma@example.com\",\"password\":\"Customer@123\"}"

# Place an order (prices/total calculated by the server from the catalog)
curl -X POST http://localhost:3010/api/orders -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d "{\"items\":[{\"productId\":\"<productId>\",\"quantity\":2}],\"clientRequestId\":\"my-request-1\"}"

# Order history / single order
curl http://localhost:3010/api/orders -H "Authorization: Bearer <token>"
curl http://localhost:3010/api/orders/<orderId> -H "Authorization: Bearer <token>"

# Admin: list + manage (Bearer = admin token from customer-login)
curl "http://localhost:3010/api/orders/admin?status=pending&page=1&limit=10" -H "Authorization: Bearer <adminToken>"
curl -X PUT http://localhost:3010/api/orders/admin/<orderId>/status -H "Authorization: Bearer <adminToken>" -H "Content-Type: application/json" -d "{\"status\":\"confirmed\"}"
```

**Inventory & transaction strategy:** every order runs inside ONE MongoDB
transaction covering all stock deductions and order creation. Each item is
deducted with the guarded atomic update
`Product.findOneAndUpdate({ _id, status: 'active', stock: { $gte: quantity } }, { $inc: { stock: -quantity } })`:
- stock can never go below zero (the `$gte` guard),
- concurrent orders competing for the same stock: a loser finds no matching
  document, its whole transaction aborts and ALL its deductions roll back
  (no partial inventory, no double deduction),
- the order document only exists if every deduction committed (ACID).

Cancellations restore stock with `$inc` **inside the same transaction** as a
conditional status change
(`findOneAndUpdate({ _id, status: { $in: ['pending','confirmed'] } })`), so
stock is restored **at most once** no matter how many cancel requests race.
Cancelled/delivered are terminal states. Re-submitting an order with the same
optional `clientRequestId` returns the existing order instead of creating a
duplicate (unique partial index per user).

**Status flow:** `pending â†’ confirmed â†’ shipped â†’ delivered`, with
`pending`/`confirmed` also cancellable. Invalid transitions are rejected (400)
and prices are always snapshotted at purchase time - later catalog edits never
rewrite order history.

### Auth service (:5011)

- `POST /auth/login` `{username,password}` â†’ `{token, user}` (demo: admin/admin123)
- `POST /auth/register` `{name,email,password,phone?,address?}` -> `201 {user}` - e-commerce customer sign-up (UserProfile, scrypt-hashed password, role always `customer`)
- `POST /auth/customer-login` `{email,password}` -> `{token,user}` - UserProfile login; returns the SAME JWT mechanism (same secret/expiry) with `sub` = UserProfile id and the profile's role (`customer`/`admin`)
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
npm test             # all Jest suites, including the performance test
npm run test:performance   # run the autocannon performance test by itself
npm run build --prefix frontend
```

The tests boot a dedicated mini-stack on ports 14001-14102/15000-15001 with a separate
`edgegate_test` database, so they never collide with the running dev stack.
The latest verification run passed **7 suites and 75 tests**. The performance
case in that run completed 358 requests at 119 requests/second, with 83 ms
average latency and zero errors; these measurements vary by machine and load.

For browser-based smoke testing, start `npm run dev`, then use
`http://localhost:5174/store` for customer workflows and the Virtual Lab,
Configuration, and Guide links for gateway demonstrations. Store API requests
use the real entry load balancer and Auth Service; this browser walkthrough is
manual rather than a checked-in Playwright suite.

## Performance testing

`npm run test:performance` runs autocannon for 3 s through the entry load balancer and
prints the **measured** throughput, average latency and error count, asserting 0 errors.
Results depend on the machine, database state, and other running processes.

## Known limitations

- MongoDB is a single-node replica set: transactions work locally, but the database
  has no replica-level availability or failover.
- Simulated fail/recover controls exercise service health behavior without killing
  OS processes. The launcher does not automatically respawn a worker that exits unexpectedly.
- In this Windows verification run, terminating a live backend worker also stopped
  the backend launcher and its concurrently managed dev stack. Hard-process crash
  recovery is therefore not claimed; injected fail/recover behavior was verified.
- Passive backend/gateway circuits use consecutive forwarding failures and active
  health checks. Simulated HTTP error responses are returned by the service and do
  not represent a crashed process; circuit behavior is intentionally simple.
- The admin product listing exposes active products only. Soft-deleted products
  are retained for past orders but cannot currently be restored through the API.
- The storefront has no payment integration; local cart contents are not persisted
  to the server.
- The frontend build succeeds but currently reports existing JSX text-character
  warnings in Virtual Lab labels and a large bundled-JavaScript chunk warning.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Failed to start EdgeGate` / Mongo timeouts | `npm run db:up`, wait a few seconds, retry |
| Redis errors | `docker ps` â€” the Redis container must be up on 6380 |
| Port already in use | `npm run stop` |
| Tests fail to boot | The test stack needs the same DB containers; check `edgegate_test` is creatable |
| Dashboard shows "Offline" | Control plane (:5010) not running â€” restart `npm run dev` |
| Routing change not visible | Check the version badge â€” each Apply creates a new version and broadcasts it |

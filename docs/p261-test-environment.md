# P2.6.1 isolated test and runtime verification

This preparation adds a dedicated Compose project for the Jest database and
Redis. Both data directories are mounted as container-local `tmpfs`; no named
or bind data volumes are used. The test ports are loopback-only (MongoDB
27019, Redis 6381), separate from the development stack (27018/6380). MongoDB
runs a single-node `rs0` replica set for transaction tests. Test URIs are
strictly pinned to those ports, test database `edgegate_test`, and Redis DB 0.

Jest's global setup requires both explicit test URI variables and inspects the
running containers before starting `stackRunner.js`. It checks the fixed
Compose project/service labels, image, healthy status, loopback port bindings,
and tmpfs-only data mounts. Jest workers reject missing overrides, preventing
the legacy `stackRunner.js` defaults from being used by the suite. The runner's
legacy defaults remain unchanged for standalone use outside Jest.

The `runtime` Compose profile uses a separate `edgegate_runtime_test` MongoDB
database, the same ephemeral Redis service, and a disposable test-only JWT
value. The frontend is exposed only at `http://127.0.0.1:8080`. Its Nginx
container keeps the fixed address `172.30.252.2`, which is the exact address
trusted by the test backend. The network uses subnet `172.30.252.0/24`,
gateway `172.30.252.1`, and dynamic allocation range `172.30.252.128/25`.
Thus Docker cannot dynamically assign the reserved `.2` address to MongoDB,
Redis, or the backend. The Compose network key is `runtime_testnet`, so the
updated IPAM configuration will not reuse the detached legacy
`gatelab-p261-test_testnet` network created before the dynamic range was
reserved. Compose does not load `.env` files into these services. The
runtime profile completed P2.6.2 end-to-end runtime verification (see the
results section below).

## Full Jest suite (run only after approval)

From the repository root in PowerShell:

```powershell
docker compose -p gatelab-p261-test -f .\docker-compose.test.yml up -d --wait

$env:JEST_TEST_MONGO_URI = 'mongodb://127.0.0.1:27019/edgegate_test?directConnection=true'
$env:JEST_TEST_REDIS_URL = 'redis://127.0.0.1:6381/0'
npm test
```

Jest will refuse to start unless those exact isolated services are healthy.
After the run, clear the shell overrides:

```powershell
Remove-Item Env:\JEST_TEST_MONGO_URI, Env:\JEST_TEST_REDIS_URL -ErrorAction SilentlyContinue
```

Run the frontend build separately:

```powershell
npm run build --prefix frontend
```

## Local runtime verification (run only after approval)

Start the same disposable database and Redis plus the backend and Nginx
storefront. This uses the separate `edgegate_runtime_test` database:

```powershell
docker compose -p gatelab-p261-test -f .\docker-compose.test.yml --profile runtime up -d --build --wait
```

Populate only that disposable runtime database with the repository's demo
catalog and users; do not run the production-only catalog seed:

```powershell
$env:NODE_ENV = 'development'
$env:MONGO_URI = 'mongodb://127.0.0.1:27019/edgegate_runtime_test?directConnection=true'
try {
  npm run seed:data
  if ($LASTEXITCODE -ne 0) { throw 'Disposable runtime seed failed' }
} finally {
  Remove-Item Env:\NODE_ENV, Env:\MONGO_URI -ErrorAction SilentlyContinue
}
```

Then open `http://127.0.0.1:8080`.

### Verification checklist

- **Nginx headers:** `curl.exe -sS -D - -o NUL http://127.0.0.1:8080/` should include
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and
  `Referrer-Policy: strict-origin-when-cross-origin`. CSP remains disabled;
  HSTS is not expected over plain HTTP.
- **Socket.IO and monitoring:** `curl.exe -sS -i
  "http://127.0.0.1:8080/socket.io/?EIO=4&transport=polling"` should return a
  Socket.IO open packet. In the browser, confirm the dashboard connects and
  its monitoring values update after generating traffic.
- **Storefront, auth, cart and checkout:** browse the seeded catalog at
  `/store`, register or log in as a customer, add an available product to the
  cart, complete checkout, and verify the order appears in the account/order
  view. The disposable seed includes `diya.sharma@example.com` /
  `Customer@123` and sample in-stock products.
- **Authentication throttling through Nginx:** send three invalid
  `/auth/customer-login` requests to `http://127.0.0.1:8080` from the same
  client within one minute. Expect two `401` responses, then `429` with
  `Retry-After`. A `/auth/register` attempt has its own counter; interleave
  registration and login attempts to verify the budgets do not share counts.
- **Lab Reset:** after creating a throttle counter in the preceding check,
  use the Virtual Lab's **Reset Lab** action. Repeat one invalid login and
  verify it returns `401` rather than `429`.
- **Worker recovery:** inspect backend logs with
  `docker logs --since 30s gatelab-p261-test-backend-1`. To terminate only the
  `4011` users worker in this disposable runtime, run:

  ```powershell
  docker exec gatelab-p261-test-backend-1 node -e "const fs=require('fs');const p=fs.readdirSync('/proc').find(n=>{if(!/^\d+$/.test(n)||Number(n)===process.pid)return false;try{const e=fs.readFileSync('/proc/'+n+'/environ','utf8').split('\0');return e.includes('ROLE=backend')&&e.includes('BE_PORT=4011')}catch(_){return false}});if(!p)throw Error('worker not found');process.kill(Number(p),'SIGKILL');console.log('terminated worker '+p)"
  ```

  Within the restart backoff, confirm the supervisor logs a refork and that a
  `ROLE=backend`, `BE_PORT=4011` worker appears again. This deliberately tests
  unexpected worker recovery; do not use it against any other container.
- **Graceful shutdown:** run
  `docker compose -p gatelab-p261-test -f .\docker-compose.test.yml --profile runtime stop backend --timeout 15`
  and confirm the backend logs `Shutting down EdgeGate...` without a worker
  refork. After the P2.6.2 fix, all 10 workers exit on their own after the
  SIGTERM drain (zero `SIGKILL` force-stops are logged). The test stack's
  worker recovery and the application's intentional shutdown are distinct checks.

## P2.6.2 runtime verification results

The following were verified end-to-end in this isolated environment with the
graceful-shutdown fix applied:

- **Startup:** the runtime profile came up healthy with the disposable
  MongoDB/Redis data services, the backend and the Nginx storefront.
- **Worker roster:** `/proc` inspection inside the backend container showed
  the cluster primary plus exactly 10 workers: `entrylb`, three `gateway`
  workers (3011-3013) and six `backend` workers (4011-4016).
- **Health checks:** `/health` on the entry LB, gateways and backend
  instances returned `200`; a request through the full
  entry-LB -> gateway -> backend chain returned `200`; the storefront at
  `http://127.0.0.1:8080/` and the Socket.IO polling endpoint returned `200`.
- **Graceful shutdown:** `docker compose ... --profile runtime stop backend
  --timeout 15` logged `Shutting down EdgeGate...`, all 10 workers received
  `SIGTERM` and exited on their own within the graceful window. No worker
  was force-stopped with `SIGKILL`, no refork/respawn occurred, and the
  container exited with code 0 (`RestartPolicy=no`).
- **Cleanup:** `docker compose -p gatelab-p261-test
  -f .\docker-compose.test.yml --profile runtime down` (without `-v`)
  removed only this project's containers and the `runtime_testnet` network.
  The detached legacy `gatelab-p261-test_testnet` network is preserved by
  design, and no volumes are involved (data is tmpfs-only).

To stop the isolated environment after verification, remove only its
containers and network (do not add `-v` or `--volumes`):

```powershell
docker compose -p gatelab-p261-test -f .\docker-compose.test.yml down
```

Because database and Redis data are tmpfs-only, container removal discards
only disposable test data. The existing development volume and all production
configuration remain outside this Compose project. `down` operates on the
current `runtime_testnet`; it intentionally does not remove the detached
legacy network from the prior configuration.

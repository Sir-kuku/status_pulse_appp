# Status Pulse

A backend monitoring capstone built with Node.js 24, TypeScript, Express 5, and the native MongoDB driver. An independent scheduler/worker checks public HTTP endpoints, derives availability, records incidents, and processes simulated alerts.

The current scope is **weeks 1–4**: requirements/design, monitoring, status/incident workflows, alerts, public status, subscriptions, and simulated plans. Weeks 5–6 reserve broader hardening, documentation polish, the final demonstration, and presentation. Tests and documentation accompany current features.

Email, subscriber verification, and payments are **simulated**. No real email is sent, no mailbox ownership is proven, and no money is charged. Adding deployment files does not establish a hosted service; follow [deployment instructions](docs/deployment.md) and record actual verification evidence.

## Run locally

Fastest option after `npm ci`: run `npm run local`, then open **http://localhost:3000/docs**. This starts the isolated persistent database, API, and independent worker together. Ctrl+C stops them and preserves data. The existing Windows MongoDB service and Atlas data are untouched.

Public project pages are available at `/status/PROJECT-SLUG` once the project and its services are public. API definitions can be imported into Postman from `/api/openapi.json`.

Use Node.js 24 and npm. Run commands from the repository root. No Atlas credentials or Docker are needed for the local replica-set option.

Install dependencies:

```powershell
npm ci
```

Create configuration once; preserve an existing .env:

```powershell
Copy-Item .env.example .env
```

On macOS/Linux use `cp .env.example .env`. The example points to a local MongoDB replica set on port 27018. Never commit .env.

In terminal 1, start the persistent development database and leave it running:

```powershell
npm run dev:db
```

On Windows the helper reuses an installed MongoDB 8.2, 8.0, or 7.0 executable with separate data and port. Otherwise the first start downloads a MongoDB executable and needs internet access. Set MONGOMS_SYSTEM_BINARY to select another compatible executable. Console output identifies its connection/storage location. A replica set supports the transactions required here; a standalone MongoDB process is insufficient.

In terminal 2, create/verify indexes:

```powershell
npm run migrate
```

Then start the API:

```powershell
npm run dev
```

In terminal 3, start the independent scheduler/worker:

```powershell
npm run dev:worker
```

Check API readiness in another terminal:

```powershell
Invoke-RestMethod http://localhost:3000/health/ready
```

A successful response means the API can reach its database. To verify the worker, create a service, wait for its interval, and inspect persisted checks. Stop development processes with Ctrl+C.

## Commands and verification

| Command | Purpose |
| --- | --- |
| npm run dev:db | Persistent local MongoDB replica set |
| npm run local | Start local database, API, and worker together |
| npm run migrate | Repeatable initial index migration |
| npm run dev | API with source reload |
| npm run dev:worker | Scheduler/worker with source reload |
| npm run typecheck | TypeScript validation without output |
| npm test | Automated tests with isolated replica sets and controlled HTTP transports |
| npm run build | Compile TypeScript into dist |
| npm run check | Typecheck, test, and build |
| npm run demo | Deterministic acceptance demo with isolated data; no Atlas credentials |
| npm start | Compiled API: node dist/src/server.js |
| npm run worker | Compiled worker: node dist/src/worker.js |
| npm run admin -- --email existing@example.com | Grant platform administration to an existing account; operator only |

Tests/demo are isolated from the persistent development database. The first test run may download MongoDB. A controlled test transport is not a production URL-validation bypass. GitHub Actions runs checks and builds the container; the workflow file alone does not prove a remote run passed.

## API documentation and first requests

[OpenAPI 3.0.3 contract](docs/openapi.json) contains schemas, roles, response envelopes, errors, and privacy boundaries. Import it into Postman or another compatible client. The API serves it at GET /api/openapi.json; /docs links to the contract.

Register with an unused email and a 15–128 character password:

```powershell
$registrationBody = @{
  name = "Project Owner"
  email = "owner@example.com"
  password = "a-long-demo-passphrase"
} | ConvertTo-Json

$registration = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/register -ContentType "application/json" -Body $registrationBody
$authHeaders = @{ Authorization = "Bearer $($registration.token)" }
```

Registration returns a safe user, bearer token, and expiry. Treat the token as a password; keep it out of source control/shared logs. Sessions normally last 24 hours and logout revokes them.

Create a project:

```powershell
$projectBody = @{
  name = "My API"
  slug = "my-api-status"
  publicEnabled = $true
} | ConvertTo-Json

$createdProject = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/projects -Headers $authHeaders -ContentType "application/json" -Body $projectBody
```

The creator becomes owner transactionally. Owners invite responder/viewer members. The invited account must authenticate and accept its simulated token. Roles are project-specific; outsiders cannot access the project.

Create a service:

```powershell
$projectId = $createdProject.project._id
$serviceBody = @{
  name = "Example endpoint"
  url = "https://example.com/"
  method = "GET"
  intervalSeconds = 60
  timeoutMs = 5000
  expectedStatusMin = 200
  expectedStatusMax = 299
  slowThresholdMs = 1000
  failureThreshold = 3
  recoveryThreshold = 2
  enabled = $true
  publicVisible = $true
} | ConvertTo-Json

$createdService = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/projects/$projectId/services" -Headers $authHeaders -ContentType "application/json" -Body $serviceBody
```

This external example is for interactive use; its availability/latency is not deterministic test evidence. GET/HEAD to public HTTP/HTTPS are supported. Private/reserved addresses, URL credentials, and redirects are blocked. Raw URLs remain private.

The worker runs checks. Initial status is unknown; defaults require two healthy successes for operational, three consecutive failures for outage, and two consecutive successes for recovery. Outage persists until recovery. Slow responses can be degraded; stale evidence is unknown. Responders resolve incidents explicitly.

Fetch current project/service/incident data before editing. Project and incident updates require the current version; service updates provide the current configuration version using the request's version field. Stale writes conflict rather than silently overwriting another change. See the contract for exact schemas.

## Simulations and visibility

- Public exposure requires project and service visibility. Public projections omit URLs, internal notes, members, tokens, and private configuration.
- Subscriber verification uses a simulated inbox. Development responses may expose a simulator token; production public responses do not. An authenticated owner retrieves the simulator inbox for coursework demonstrations.
- Alert delivery failure/success and human acknowledgement remain distinct. Authorized responders can simulate failure and retry.
- A payment idempotency key identifies an upgrade. Failure preserves the plan; retry with the same key may succeed; successful replay does not reactivate it.
- Invitations cannot grant owner or platform administrator status. Administrator provisioning is an operator action.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| NODE_ENV | development; production requires HTTPS public URL |
| PORT | 3000 |
| MONGODB_URI | Local replica-set URI; secret when it includes credentials |
| MONGODB_DATABASE | status_pulse |
| PUBLIC_BASE_URL | http://localhost:3000; deployed HTTPS origin in production |
| WORKER_CONCURRENCY | 4, allowed 1–16 |
| WORKER_POLL_MS | 1000, allowed 250–60000 |
| SESSION_TTL_HOURS | 24, allowed 1–168 |
| ENABLE_SIMULATIONS | true; false disables simulator paths, not an automatic real-provider switch |

Index migration is rerunnable and also runs during database connection startup. Database constraints enforce unique emails, memberships, job slots/results, alerts, subscriptions, and payment keys. Future schema changes need explicit migrations; do not erase collections to fix an error.

## Design and remaining work

See [verified progress and deployment blockers](docs/progress.md) for the current milestone status and recorded local evidence.

[Requirements](docs/requirements.md) and [week 1 analysis](docs/week-1-analysis.md) contain stories, acceptance criteria, roles, data model, and architecture tradeoffs.

Durable leases and unique keys prevent duplicate authoritative records; transactions keep results/status/incidents/alerts consistent. A crash after sending HTTP can cause a repeated request: the claim is one authoritative stored outcome per job, not universal exactly-once external execution.

Historical resources are archived. The single-node development replica set is not highly available. Simulations are not real provider integrations. Weeks 5–6 and actual hosted verification remain separate work. Docker files are supplied but were not executed in this Windows workspace because no Docker engine was available.
#   s t a t u s _ p u l s e _ a p p  
 

# Status Pulse

Status Pulse helps a team answer three practical questions: are our services working, what are we doing about a problem, and what should our users know? It checks public HTTP endpoints, records their status, manages incidents and alerts, and publishes a safe status page.

This repository brings the six-week project together: the monitoring backend, a responsive browser dashboard, regression tests, API documentation, deployment configuration, and a presentation guide. The dashboard uses the same authenticated API as other clients; monitoring continues in an independent worker process.

**Email, subscription verification, invitations, and payments are simulations.** No email is sent, mailbox ownership is not proven, and no money is charged. Local verification and hosted deployment are recorded separately in the [final delivery report](docs/final-delivery.md).

## Start the project

Use Node.js 24 and npm. From the repository directory:

```powershell
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm run local
```

Open **http://localhost:3000/** for the dashboard. The helper starts a persistent, isolated MongoDB replica set, the API, and an independent worker. Stop it with Ctrl+C; your local data is preserved. It does not use or modify an existing Windows MongoDB service or an Atlas database.

On macOS/Linux, create configuration with `test -f .env || cp .env.example .env`. The first MongoDB start may need internet access to download a binary. On Windows, the helper can reuse an installed MongoDB executable. Set `MONGOMS_SYSTEM_BINARY` to choose a compatible executable explicitly.

If `.env` already points to Atlas or another database, use the separate processes below instead of `npm run local`. The combined helper deliberately accepts only its isolated local database URI.

| Address | What you will find |
| --- | --- |
| `/` | Team dashboard and account access |
| `/status/PROJECT-SLUG` | A project's public status page, when enabled |
| `/docs` | API reference |
| `/api/openapi.json` | OpenAPI contract for Postman or other clients |
| `/health/live` | Whether the API process responds |
| `/health/ready` | Whether the API can reach its database |

Readiness does not prove the worker is making progress. Create a monitor and inspect its stored check results to verify the complete system.

## Try it in the browser

1. Create an account using a unique email and a password of 15–128 characters.
2. Create a project, then add a public HTTP or HTTPS endpoint as a monitor. Choose whether it should appear on the public status page.
3. Wait for the worker, or queue a check from the monitor details. The initial state is **unknown** until enough evidence exists.
4. Inspect response times, recent checks, and status history. Defaults require two healthy checks for operational status, three consecutive failures for an outage, and two consecutive successes for recovery.
5. Open an incident, add updates through investigating → identified → monitoring → resolved, and acknowledge its alert. Recovery and acknowledgement are separate decisions.
6. Open the public page in a separate browser context. Only explicitly public services and incident information should appear.

Project owners configure monitors, manage members, change visibility, and simulate plan upgrades. Responders investigate incidents, queue checks, set temporary overrides, and acknowledge alerts. Viewers can inspect their project's information. Platform administration is provisioned separately.

The interface uses live API data. An empty history means no checks have been recorded; a queued check needs a running worker. Public example endpoints are useful for interaction, but their current response time is not a repeatable test fixture. Use the [demo guide](docs/final-delivery.md#demonstration-walkthrough) for a presentation with repeatable evidence.

## Run the pieces separately

Keep each long-running command in its own terminal:

```powershell
# Terminal 1: local database; omit this when using Atlas
npm run dev:db
```

```powershell
# Terminal 2: explicit, repeatable index migration, then the API
npm run migrate
npm run dev
```

```powershell
# Terminal 3: scheduler and monitoring worker
npm run dev:worker
```

A MongoDB **replica set** is required because related writes use transactions. A standalone MongoDB process is insufficient. Startup also applies the named index migration, so migration can safely be repeated.

## Verify the work

```powershell
npm run check
npm run test:e2e
npm run demo
```

`check` runs TypeScript and browser JavaScript validation, the OpenAPI contract check, backend tests, and a production build. `test:e2e` checks real browser workflows against an isolated API. On Windows it uses installed Chrome by default; other platforms use Playwright Chromium (`npx playwright install chromium`). See the [browser setup](docs/final-delivery.md#verification-record) for alternatives. `demo` runs integrated acceptance scenarios and writes `.local/verification/demo.json`. All three use isolated replica sets and controlled checker outcomes, without touching the persistent development database or requiring Atlas credentials. `npm run verify` runs the three commands together.

The [final delivery report](docs/final-delivery.md#verification-record) records the latest actual results and their limits. The [requirements matrix](docs/requirements.md#implementation-and-verification-map) connects every acceptance criterion to the implementation and relevant checks. Generated reports, screenshots, local databases, dependencies, and build output are excluded from source control; include only the evidence you intend to submit.

| Command | Purpose |
| --- | --- |
| `npm run local` | Start the isolated local database, API, and worker |
| `npm run dev:db` | Run only the persistent development replica set |
| `npm run dev` / `npm run dev:worker` | Run the API / worker with source reload |
| `npm run migrate` | Apply or verify indexes |
| `npm run typecheck` | Check TypeScript without emitting files |
| `npm run contract` | Validate the OpenAPI contract |
| `npm test` | Run automated regression tests |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm run check` | Validate source and contract, run backend tests, and build |
| `npm run test:e2e` | Check desktop/mobile browser workflows against an isolated API |
| `npm run verify` | Run checks, browser workflows, and acceptance demonstration |
| `npm run demo` | Run deterministic acceptance scenarios |
| `npm start` / `npm run worker` | Run the compiled API / worker |
| `npm run admin -- --email ACCOUNT_EMAIL` | Give an existing account platform administration; operator action |

## Configuration

Copy the example once and keep secrets in `.env` or the host's secret settings. Do not replace an existing environment file when updating the project.

| Variable | Default and meaning |
| --- | --- |
| `NODE_ENV` | `development`; production requires an HTTPS public URL |
| `PORT` | `3000` |
| `MONGODB_URI` | Local replica set on `127.0.0.1:27018`; use a secret URI for Atlas |
| `MONGODB_DATABASE` | `status_pulse` |
| `PUBLIC_BASE_URL` | `http://localhost:3000`; actual HTTPS origin when hosted |
| `WORKER_CONCURRENCY` | `4`; allowed range 1–16 |
| `WORKER_POLL_MS` | `1000`; allowed range 250–60000 |
| `SESSION_TTL_HOURS` | `24`; allowed range 1–168 |
| `ENABLE_SIMULATIONS` | `true`; disabling this does not configure real providers |

## How the project is organised

```text
src/       API, domain rules, database setup, monitoring, and worker
public/    Browser dashboard, styles, and static assets
tests/     API, business, monitoring, network-safety, and failure regressions
scripts/   Local startup, migration, administration, demo, and contract checks
docs/      Requirements, architecture, workflow, deployment, and final delivery
```

The frontend uses HTML, CSS, and JavaScript served by Express. The backend uses Node.js 24, TypeScript, Express 5, and the native MongoDB driver. There is no separate frontend development server or additional frontend build step.

Start with the [workflow overview](docs/workflow-overview.md) for a plain-language tour. Read the [architecture analysis](docs/week-1-analysis.md) for data and reliability decisions, the [requirements](docs/requirements.md) for the full acceptance criteria, and the [deployment guide](docs/deployment.md) for native, Docker, or hosted operation. The [final delivery report](docs/final-delivery.md) includes the week 5–6 work, verification record, demo sequence, and presentation outline.

## Boundaries that matter

Monitoring accepts GET/HEAD to public HTTP/HTTPS destinations. Private and reserved network addresses, URL credentials, and redirects are blocked. Raw endpoint URLs stay out of public output. Changes use server-side authorization and revision checks so stale edits cannot silently overwrite newer work.

Durable jobs, leases, unique indexes, and transactions provide one authoritative stored result per job. A crash after an HTTP request can cause that request to be sent again. Historical resources are archived rather than erased. Local single-node MongoDB supports transactions but is not highly available.

Docker and Render configuration are included. Those files do not prove a live deployment; hosted API, database, and worker verification must be recorded against the deployed revision. Real email, payment processing, multi-region monitoring, and automatic remediation remain outside this coursework scope.

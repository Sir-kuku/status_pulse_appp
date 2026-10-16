# Weeks 1–4 progress

Scope: weeks 1–4 only. Weeks 5–6 remain deferred. Local verification date: 16 October 2026.

| Milestone | Implementation | Evidence / remaining work |
| --- | --- | --- |
| Week 1: requirements and design | Complete | requirements.md, week-1-analysis.md, validated OpenAPI contract with 40 paths |
| Week 2: initial API and monitoring | Complete locally | Accounts, invitations, roles, services, configuration history, scheduler, fenced workers, durable check results |
| Week 3: core behavior | Complete locally | Thresholds, stale/disabled unknown, expiring overrides, manual/automatic incidents, ordered lifecycle, history and audit |
| Week 4: integration | Complete locally; hosted verification pending | Alerts/retries/acknowledgement, safe public API/HTML, verified simulated subscriptions, idempotent simulated plan upgrade, separate API and worker |

## Verification

- Automated tests exercise account/session lifecycle, project isolation, invitation acceptance, role gates, concurrent edits, endpoint safety, DNS pinning, HTTP timeout/redirect behavior, worker leases/retries, incidents, visibility, subscriptions, alerts and payments.
- `npm run demo` passed all 10 acceptance scenarios using a fresh isolated MongoDB replica set and controlled check outcomes. Results: [local-demo.json](evidence/local-demo.json).
- `npm run local` started a persistent local replica set, API, and separate worker. The worker scheduled and saved a real successful HTTP 200 observation. API readiness and the public HTML demo page responded successfully. Results: [local-runtime.json](evidence/local-runtime.json).
- `npm run contract` validated OpenAPI 3.0.3 with 40 documented paths. The contract is served at `/api/openapi.json` and can be imported into Postman.
- Dependency audit reported zero vulnerabilities at install time.

Run `npm run check` for typechecking, contract validation, automated tests, and compilation. Test databases are isolated from both local persistent data and Atlas. Windows helpers can reuse an installed MongoDB executable while giving it its own data directory and ports. Startup allowance is 60 seconds for slower machines; this does not change application check timeouts.

## Remaining deployment work

The configured Git remote is `https://github.com/Sir-kuku/status_pulse_app.git`. Access verification returned **Repository not found**; the repository may need to be created, its URL corrected, or the correct GitHub account authenticated. No successful push or remote CI run is claimed.

`render.yaml` and `.github/workflows/ci.yml` are ready for review. The Render design uses a Free API and a separate paid background worker. No paid resources have been created. Once GitHub access and the worker plan are settled, enter the Atlas secret in Render, allow the services' outbound addresses in Atlas, deploy, and record hosted API/worker evidence. See [deployment.md](deployment.md).

Docker is not installed in this workspace, so container build and Compose execution have not been verified locally. GitHub CI includes those checks. Email and payments remain explicit simulations: no real mail is sent and no money is charged.

## Running and reviewing

Start everything locally with `npm run local`. Open `/docs` for the API reference and `/status/local-demo` for the prepared public example. If the local processes are already running, use the existing URLs instead of starting a second database.

The local demonstration account's generated credentials are stored only in `.local/demo-access.json`, which Git ignores. Register your own account through the API for normal work. Stop the foreground local launcher with Ctrl+C; its data stays in `.local/mongo`.

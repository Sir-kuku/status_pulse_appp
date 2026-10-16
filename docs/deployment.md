# Deployment and environment guide

## Delivery status

A runtime image definition and local Compose stack are included. **No hosted URL or remote worker has been provisioned or verified by this document.** GitHub Actions [run 38935236704](https://github.com/Sir-kuku/status_pulse_appp/actions/runs/38935236704) passed the tests, contract validation, compilation, Compose configuration validation, and Docker image build. Docker/Compose were not executed locally. Deployment is complete only after verification succeeds in the target environment.

## GitHub and Render

The user-selected deployment target is GitHub plus Render. The root `render.yaml` defines a Free web API and a separate **paid** background worker using the `0.5c-512mb` compute plan. Review the displayed charge before creating that worker. Render has no free background-worker plan. Its Free web service can spin down when idle, so the first request after inactivity can be delayed. The paid worker continues monitoring independently. No paid service has been created here. [Render free-service limits](https://render.com/docs/free), [compute plans](https://render.com/docs/compute-plans)

1. The project is available in [Sir-kuku/status_pulse_appp](https://github.com/Sir-kuku/status_pulse_appp), branch `main`. Open its **Actions** tab and confirm the **Backend checks** workflow is green for the version you are deploying.
2. In the [Render dashboard](https://dashboard.render.com), select **New > Blueprint**. Connect your GitHub account if needed, grant Render access to this repository, and select **Connect** beside `status_pulse_appp`. Use Blueprint name `status-pulse`, branch `main`, and Blueprint path `render.yaml`. Select the repository through the GitHub integration so automatic deployments and check results are available. [Blueprint setup](https://render.com/docs/infrastructure-as-code)
3. Review the two resources: `status-pulse-api` (Free) and `status-pulse-worker` (paid). The file already specifies Docker, region, commands, and health check. Do not add npm build/start commands. Their `checksPass` trigger deploys updates after GitHub checks pass. [Blueprint reference](https://render.com/docs/blueprint-spec)
4. Render asks for two values for **each service**. Set `MONGODB_URI` to the Atlas URI below with your database-user password percent-encoded. Keep the actual URI in Render's environment settings. Set `PUBLIC_BASE_URL` temporarily to `https://example.invalid` because the actual hostname is not assigned yet. This temporary value must be replaced in step 6. The other variables are supplied by the Blueprint.

   ```text
   mongodb+srv://status_pulse_app:ENCODED_PASSWORD@cluster0.t9tey8e.mongodb.net/status_pulse?retryWrites=true&w=majority&authSource=admin
   ```

   Use the password created for `status_pulse_app`, not your Atlas website login. Replace only `ENCODED_PASSWORD`; do not include angle brackets. Percent-encode reserved characters (for example, `@` becomes `%40`). Never commit or post the completed URI.

5. After reviewing the displayed worker cost, click **Deploy Blueprint**. Open each created service, choose **Connect > Outbound**, and copy all displayed IP ranges (including their `/...` suffixes). In Atlas, go to **Database & Network Access > IP Access List > Add IP Address**, add those ranges, and wait until active. Both services are in Frankfurt and may show the same ranges; identical entries only need adding once. [Render outbound IP instructions](https://render.com/docs/outbound-ip-addresses)
6. Copy the actual `https://...onrender.com` address displayed on the **API** service. In the **Environment** settings of both the API and worker, replace `PUBLIC_BASE_URL` with that API address. Save and redeploy. If initial startup failed before Atlas access was ready, use **Manual Deploy > Deploy latest commit** on both services after the IP entries are active. The worker uses the API's address and has no public website URL of its own.
7. Open the API address followed by `/health/ready` (expect `{"status":"ready"}`) and `/docs`. The worker logs should show `Status Pulse scheduler and check worker started.` Register/create a project and service through the API and confirm new scheduled results appear; this verifies the worker beyond startup. Local demo accounts and data are not automatically copied to Atlas. Record the deployed URL and worker evidence below.

The API runs `node dist/src/server.js`; the worker runs `node dist/src/worker.js`. Both connect to the same Atlas database. Public status pages use `/status/PROJECT-SLUG`.

Platform administrators are provisioned separately: register the intended account, then run `npm run admin -- --email ACCOUNT_EMAIL` from an operator checkout configured for that same database. Normal signup never grants administration. `/api/admin/operations` reports worker heartbeats and failures; `/api/admin/audit` reports audit events.

## Environment choices

| Environment | Database | API | Worker |
| --- | --- | --- | --- |
| Native local | npm run dev:db, persistent replica set on 127.0.0.1:27018 | npm run dev | npm run dev:worker |
| Local containers | Internal mongo:27017, single-node rs0 | Container on 127.0.0.1:3000 | Separate container |
| Shared/test host | Atlas or another secured replica set | HTTPS service using runtime image | Background service using same image |

Standalone MongoDB cannot provide the required multi-document transactions. Single-node replica sets support local transactions but offer no high availability. Replica member hostnames must be reachable by clients. [MongoDB replica-set setup](https://www.mongodb.com/docs/manual/tutorial/deploy-replica-set/)

## Local containers

With Docker and Compose installed, run from the repository root:

```powershell
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs --tail 50 api worker
```

The database health check initializes rs0 once and waits for a writable primary. API/worker depend on database health. MongoDB has no host-published port; the API binds only to 127.0.0.1. This unauthenticated database is suitable only for the local Compose network. [Docker readiness dependency behavior](https://docs.docker.com/compose/how-tos/startup-order/)

Verify readiness:

```powershell
Invoke-RestMethod http://localhost:3000/health/ready
```

Create a scheduled service and inspect completed checks to verify the worker. Stop while retaining the named volume:

```powershell
docker compose down
```

Do not add volume removal when preserving history. Native and Compose databases are distinct stores. Avoid running both APIs on port 3000 simultaneously.

## Atlas

Create a MongoDB **database user**, distinct from an Atlas website account, with read/write access to status_pulse rather than every database. The current application creates collections/indexes at startup, so the role must allow those operations. Stricter migration/runtime role separation requires changing startup migration behavior.

For local access allow the developer's current IP; for deployment allow the host's documented outbound addresses. Do not routinely open the database to all addresses. Atlas needs an authorized database user and network source. [Atlas driver connection instructions](https://www.mongodb.com/docs/atlas/driver-connection/)

Store credentials in .env or host secrets:

```dotenv
MONGODB_URI=mongodb+srv://APP_USER:ENCODED_PASSWORD@YOUR_CLUSTER.mongodb.net/status_pulse?retryWrites=true&w=majority&authSource=admin
MONGODB_DATABASE=status_pulse
```

Use your actual Atlas hostname. Percent-encode reserved characters in username/password components, not the whole URI; @ in a password becomes %40. authSource=admin specifies authentication while status_pulse is the application database. [MongoDB connection options](https://www.mongodb.com/docs/manual/reference/connection-string-options/)

Distinguish DNS/allowlist issues from credentials/authSource or missing privileges. Never post credential-bearing URIs in screenshots. [Atlas troubleshooting](https://www.mongodb.com/docs/atlas/troubleshoot-connection/)

## Shared/test services

Validate before publishing:

```powershell
npm ci
npm run check
docker build -t status-pulse:review .
```

The multi-stage Dockerfile compiles with locked build dependencies, installs production-only runtime dependencies, and runs as the non-root node user. Tests/local MongoDB binary tooling are not runtime requirements.

Provision two services from the reviewed image:

| Service | Start command | Exposure |
| --- | --- | --- |
| API | node dist/src/server.js | Host HTTPS ingress to PORT |
| Scheduler/worker | node dist/src/worker.js | No public HTTP ingress |

Both share database configuration and simulation policy. Use the host-assigned port for the API:

```dotenv
NODE_ENV=production
PORT=3000
MONGODB_URI=<secret Atlas replica-set URI>
MONGODB_DATABASE=status_pulse
PUBLIC_BASE_URL=https://<deployed-api-hostname>
WORKER_CONCURRENCY=4
WORKER_POLL_MS=1000
SESSION_TTL_HOURS=24
ENABLE_SIMULATIONS=true
```

Production rejects non-HTTPS PUBLIC_BASE_URL. Configure actual host TLS; a URL variable does not enable encryption. Configure reverse-proxy/rate-limit behavior for the actual topology rather than trusting arbitrary forwarded headers.

Database connection applies the repeatable named index migration. A source-based release job with development tools can run npm run migrate explicitly. Do not run the development database helper on the host. Preserve the database independently of process restarts.

Production simulation still sends no real email or payments. Public responses suppress verification tokens; owners use the protected simulator inbox. Switching ENABLE_SIMULATIONS off does not configure real delivery.

## Deployment evidence

Record deployed URL, source revision/image, verification date, and outputs when these actually pass:

1. Liveness succeeds and readiness confirms database access.
2. Registration/login/project creation work; unrelated accounts cannot access the project.
3. A public-safe endpoint produces persisted scheduled results from the independent worker.
4. Failure/recovery thresholds, history, overrides, and stale unknown behave correctly.
5. Repeated processing produces no duplicate authoritative result, active incident, or alert.
6. Simulated alert failure/retry and separate acknowledgement work.
7. Public output omits private services, URLs, notes, memberships, and tokens.
8. Selected-service subscription verification and public notifications work through simulation.
9. Failed payment preserves free plan; retry succeeds and replay activates once.
10. API/worker restarts preserve data and resume eligible work.
11. Authorized audit/administration show changes/failures without secrets.
12. Limitations and deferred weeks 5–6 work are recorded.

Use controlled tests/demo for repeatable timeout/crash/concurrency scenarios. The isolated local demo does not verify the deployed network/database/worker.

## Operational limits

The local database is unauthenticated and not publicly exposed. Hosted databases need access controls, backups, and capacity monitoring. Readiness is not worker-progress monitoring; later hardening should detect stalled jobs and repeated/exhausted failures.

Application SSRF protection validates/pins public destinations and blocks redirects. Hosting egress controls are additional defense only if actually configured; these files do not establish cloud infrastructure isolation.

CI uses official [checkout](https://github.com/actions/checkout) and [setup-node](https://github.com/actions/setup-node) actions. A workflow file does not trigger CI or publish an image without a configured repository/host.

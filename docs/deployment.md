# Running and deploying Status Pulse

Status Pulse has two application processes: the web API, which also serves the frontend, and the scheduler/worker, which performs monitoring. Both need the same MongoDB replica set and database. A working homepage is only one part of a working deployment.

The repository includes native development scripts, Docker Compose, a production Dockerfile, and a Render Blueprint. The [final delivery report](final-delivery.md#verification-record) records what has actually been executed. No hosted deployment is claimed by this guide.

## Choose an environment

| Environment | Database | Web process | Background process |
| --- | --- | --- | --- |
| Local native | Persistent replica set on `127.0.0.1:27018` | `npm run dev` | `npm run dev:worker` |
| Local containers | Internal `mongo:27017`, replica set `rs0` | API container on `127.0.0.1:3000` | Separate worker container |
| Shared host | Atlas or another secured replica set | HTTPS web service | Background worker using the same image |

Use Node.js 24. A standalone MongoDB process cannot provide the multi-document transactions used by this project. The combined `npm run local` command is the easiest local route; the [README](../README.md#start-the-project) covers it.

## Local containers

With Docker and Compose available, run:

```powershell
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs --tail 50 api worker
```

Compose waits for the database health check to initialize the replica set and report a writable primary before starting the API and worker. Docker explains this dependency behavior in its [startup-order documentation](https://docs.docker.com/compose/how-tos/startup-order/).

Open `http://localhost:3000/` and check readiness:

```powershell
Invoke-RestMethod http://localhost:3000/health/ready
```

Create a monitor and verify that stored check results appear. Stop the containers while preserving the named database volume:

```powershell
docker compose down
```

The Compose database is unauthenticated, has no host-published port, and belongs only on the local container network. The API binds to loopback. Native and Compose databases are separate stores. Avoid running both APIs on port 3000 at once, and do not remove the database volume when preserving history.

## Prepare a release

From the version you intend to deploy:

```powershell
npm ci
npm run check
npm run test:e2e
npm run demo
docker build -t status-pulse:review .
```

The Dockerfile compiles TypeScript with build dependencies, copies the compiled API/worker plus frontend assets and documentation, installs production runtime dependencies, and runs as the non-root `node` user. The runtime image does not need the local MongoDB test helper.

| Process | Command | Exposure |
| --- | --- | --- |
| Web API and frontend | `node dist/src/server.js` | Host HTTPS ingress to `PORT` |
| Scheduler/worker | `node dist/src/worker.js` | No public HTTP ingress |

The frontend is served by the API process. Deploying only static files would leave authentication, project data, and monitoring unavailable.

## Database and environment

Create an Atlas database user with the permissions needed for `status_pulse`, including collection/index creation at startup. This is separate from the Atlas website login. Restrict database network access to the clients and host egress ranges that need it. See the official [Atlas connection instructions](https://www.mongodb.com/docs/atlas/driver-connection/).

Store the actual URI in host secrets, never in source control or screenshots. Use your cluster hostname and percent-encode reserved characters in credentials once:

```dotenv
NODE_ENV=production
PORT=3000
MONGODB_URI=mongodb+srv://APP_USER:ENCODED_PASSWORD@YOUR_CLUSTER.mongodb.net/status_pulse?retryWrites=true&w=majority&authSource=admin
MONGODB_DATABASE=status_pulse
PUBLIC_BASE_URL=https://YOUR_API_HOSTNAME
WORKER_CONCURRENCY=4
WORKER_POLL_MS=1000
SESSION_TTL_HOURS=24
ENABLE_SIMULATIONS=true
```

Both application processes use the same database and simulation policy. Use the platform's assigned port when provided. `PUBLIC_BASE_URL` must be the actual HTTPS origin in production; the variable itself does not configure TLS. Startup applies the repeatable named index migration. Future schema changes should have explicit migrations, not instructions to erase collections.

The API's production proxy configuration assumes one trusted proxy hop. Review that setting if you deploy behind a different topology, since it affects client IP identification and rate limiting.

## Render setup

The supplied `render.yaml` declares a Docker web service and a Docker background worker. Its web plan is `free` and its worker plan is `0.5c-512mb`. The worker uses paid compute; review the price shown by Render before creating resources. The official [Blueprint reference](https://render.com/docs/blueprint-spec) describes these fields and plan identifiers.

1. Connect the intended repository and revision through Render's Blueprint flow, using `render.yaml` at the repository root. Confirm the checks for that revision passed.
2. Review the API and worker resources and their displayed cost. Enter `MONGODB_URI` and `PUBLIC_BASE_URL` for both services through environment settings. If the API hostname is not assigned yet, replace any temporary HTTPS placeholder with the real origin as soon as the service is created.
3. Add the API and worker's documented outbound IP ranges to Atlas network access. Render lists those ranges in the service's **Connect → Outbound** view; follow its [outbound IP instructions](https://render.com/docs/outbound-ip-addresses).
4. Redeploy both services after the database access list and real public origin are set. The web service uses the Dockerfile command; the worker overrides it with `node dist/src/worker.js`.
5. Check the homepage, API readiness, and the worker logs. Then create a monitor and verify a new stored check. Record the source revision, URL, time, and evidence below.

Local accounts and demo records are not copied to the hosted database. The worker has no public website URL; its `PUBLIC_BASE_URL` is the API's origin.

## Administrator access

Register the intended account first. From an operator checkout configured for the same database, run:

```powershell
npm run admin -- --email operator@example.com
```

The protected `/api/admin/operations` route exposes recent worker heartbeat and failure information. `/api/admin/audit` exposes audit events. Project ownership alone does not grant access, and platform administration does not automatically reveal private project data through ordinary project routes.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Homepage loads but no checks appear | Confirm the independent worker runs against the same database; inspect job failures and worker heartbeat |
| Readiness returns unavailable | Inspect the sanitized startup/connection diagnostic and database reachability |
| Authentication failure | Check the database user's password, credential encoding, and `authSource` |
| Permission denied / code 13 | Check the database name and user's permissions for it |
| Connection unavailable | Verify the hostname, network access list, and both services' egress ranges |
| Index conflict / code 85 or 86 | Compare existing indexes with the migration before changing data |
| Duplicate records / code 11000 | Investigate the conflicting unique values; do not erase the database |
| Atlas code 8000 | Read the sanitized explanation and failing phase; that code has several possible causes |
| Public page returns 404 | Confirm the project is public, unarchived, and its slug matches |
| Status remains unknown | Wait for enough successful checks, or inspect missing/stale results and worker failures |

Startup diagnostics identify the failing phase and redact connection strings, credentials, and command/document bodies. A successful image build does not verify a database connection.

## Hosted verification record

Fill this in only after checking the deployed environment. The isolated demo is useful acceptance evidence, but it cannot prove the host's network, database, or worker is working.

| Item | Evidence to record |
| --- | --- |
| Release | Source revision/image and deployment time |
| Web/API | Actual HTTPS URL, homepage, `/health/live`, `/health/ready`, and API contract |
| Accounts and roles | Registration/login, project creation, and unrelated-account denial |
| Worker | Persisted scheduled check with timestamp plus worker heartbeat |
| Persistence | API/worker restart retains data and resumes eligible work |
| Status and incidents | Failure/recovery, history, override expiry, and explicit lifecycle |
| Alerts | Failed/successful simulation and separate acknowledgement |
| Public visibility | Hidden service/URL/internal-note exclusion and public subscription flow |
| Plans | Failed payment preserves plan; successful retry/replay activates once |
| Operations | Restricted administration, useful failure evidence, and safe logs |

## Operational limits

Simulations remain simulations in production. Public verification responses suppress tokens; the project owner can retrieve demonstration tokens through the protected inbox. Setting `ENABLE_SIMULATIONS=false` disables those flows and does not install a real provider.

Hosted operation still needs appropriate backups, restore drills, monitoring, capacity planning, and access controls. A single-node local replica set is not high availability. Application destination validation adds SSRF protection, but hosting egress isolation exists only when it has actually been configured. The current GitHub Actions file defines checks and container-build verification; its presence alone does not prove a remote run or publish an image.

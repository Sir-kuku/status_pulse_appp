# Status Pulse — Requirements and acceptance criteria

> Product extension: real email and social identity supersede the original simulation-only email statements below. The original 48 coursework criteria remain traceable in local demonstration mode. Production requires real providers; see the extension requirements at the end.

## Purpose

Status Pulse is a monitoring platform with a browser dashboard and an HTTP API. Teams register HTTP services, run scheduled checks, calculate availability, investigate incidents, receive and acknowledge alerts, and share selected information through public status pages. Visitors can subscribe to public services. An advanced monitoring plan uses simulated payments only.

The engineering goal is a system whose behavior can be explained and verified, including failures, retries, concurrent workers, and unauthorized access. The original SP, US, and AC identifiers are retained so the final work can be reviewed against the same requirements. The implementation map below identifies relevant source and tests; execution results belong in the final delivery report.

## Delivery boundary

The delivery scope now covers **weeks 1–6**, including the final dashboard, reliability review, documentation, demonstration, and presentation material. Tests, security, and reliability remain part of each feature rather than a last-week exercise.

| Week | Intended outcome | Evidence to collect |
| --- | --- | --- |
| 1 | Requirements, acceptance criteria, architecture, incremental data model, and initial API contract | This document, week-1 analysis, design decisions, and API contract |
| 2 | Accounts, project permissions, service configuration, and reliable scheduled checks (SP-01–SP-03) | Running API/worker, database setup, automated tests, and example requests |
| 3 | Status calculation, thresholds, history, overrides, and incident lifecycle (SP-04–SP-05) | Failure/recovery, stale results, state transition, and duplicate-processing tests |
| 4 | Alerts/acknowledgements, safe public status, subscriptions, simulated payment, and integration (SP-06–SP-07 plus supporting SP-08 audit) | Integrated scenarios, failure/retry evidence, API documentation, and shared/test deployment verification |
| 5 | Regression/failure testing, reliability hardening, responsive frontend, and documentation review | Failure/concurrency regression tests, UI checks, updated architecture and requirements |
| 6 | Final implementation review, demonstration, presentation, and delivery | Final verification report, workflow overview, demo walkthrough, and presentation outline |

Shared/test deployment is complete only after the deployed API and worker have been checked. Local success alone does not prove deployment.

## Actors and permission boundaries

Authentication identifies the caller. Authorization decides what that caller can do in a particular project. Roles are scoped memberships, not a global property of a user.

| Action | Owner | Responder | Viewer | Anonymous / subscriber | Platform administrator |
| --- | --- | --- | --- | --- | --- |
| Create a project | Any signed-in user; creator becomes owner | Any signed-in user | Any signed-in user | No | Through normal account workflow |
| Read assigned project's services, checks, statuses, incidents | Yes | Yes | Yes | Public projection only | No automatic private membership |
| Configure/archive services or change visibility | Yes | No | No | No | No automatic project privilege |
| Invite members as responder/viewer | Yes | No | No | No | No automatic project privilege |
| Create/update incidents and apply status overrides | Yes | Yes | No | No | No automatic project privilege |
| Read project alerts | Yes | Yes | Yes | No | Operational metadata only |
| Acknowledge project alerts | Yes | Yes | No | No | No automatic project privilege |
| Change plan through simulated payment | Yes | No | No | No | No automatic project privilege |
| Read public status and public incident updates | Yes | Yes | Yes | Yes | Yes |
| Subscribe to public services | Yes | Yes | Yes | Yes, after simulated verification | Yes |
| Review platform scheduler/worker failures and audit | No global access | No global access | No global access | No | Yes |

No role may read password hashes, session-token hashes, verification-token hashes, or endpoint credentials in API responses. Administration is a separately provisioned operational role; registration cannot request it. Owner permissions include responder actions. Owner transfer/removal is outside v1; ordinary invitations cannot grant owner status.

## V1 policies

These policies make the acceptance criteria precise. They are project design decisions, not additional requirements attributed to an unseen marking rubric. Keep code, API documentation, and tests aligned when they change.

- Use Node.js 24, TypeScript, Express 5, and the native MongoDB driver in one modular application. Run the HTTP API separately from the MongoDB-backed scheduler/worker process. Use a MongoDB replica set for multi-document transactions.
- Signup requires a name of 1–100 characters and a password of 15–128 characters, without composition rules. Trim and lowercase email for identity comparison; enforce normalized uniqueness in the database. Store passwords with a suitable salted, one-way password hash.
- Use opaque random bearer session tokens with a 24-hour lifetime. Store token hashes only. Check expiry and revocation during authentication.
- Project memberships are owner/responder/viewer. Owners invite an email address as responder or viewer through a simulated flow. The invited person must register/log in with that email and accept a one-use token within 24 hours. Reissuing an invitation invalidates its earlier unaccepted tokens. No real email is sent.
- Monitor GET/HEAD only against public HTTP/HTTPS destinations. Reject URL credentials, custom authentication headers, private/reserved addresses, and unsupported protocols. Disable redirects. Keep raw monitoring URLs out of public output.
- Supported intervals are 30, 60, 120, 300, and 600 seconds. Free plans have a 60-second minimum; advanced plans permit 30 seconds. Default interval is 60 seconds.
- Timeout is 500–10,000 milliseconds, defaults to 5,000 milliseconds, and must be shorter than the interval. Expected response defaults to HTTP 200–299 via expectedStatusMin/expectedStatusMax. Slow response threshold defaults to 1,000 milliseconds.
- Default failure threshold is three consecutive failures; recovery requires two consecutive successes. Before the first healthy threshold is reached, successful evidence remains unknown. Failures before outage are degraded. Once outage is reached, retain outage until the recovery threshold is satisfied. Slow responses can yield degraded according to the documented status-engine policy.
- Missing or stale evidence produces unknown. Staleness is max(three configured intervals, timeout plus interval), effectively three intervals under these configuration limits. A completed timeout is a failed observation; a worker that never completes creates missing evidence.
- Overrides require actor, reason, and expiry. Keep calculated status distinct from effective overridden status. Expired overrides cease to apply without erasing history.
- Incidents follow investigating → identified → monitoring → resolved. No skipped/reversed transitions or automatic resolution in v1. Recovery allows responders to advance their investigation; it does not impersonate a responder's decision.
- Email delivery, subscriber verification, and payments are simulations. A failed delivery is not delivered; an unverified subscriber is not verified; a failed payment does not change the plan.
- Archive historical resources instead of hard-deleting them. Archived/disabled services produce no new scheduled work. Preserve checks, incidents, payment attempts, and audit evidence.

## SP-01 — Accounts, projects, and permissions

### US-01 — Register an account

As a developer, I want to register an account so that I can use
Status Pulse to manage monitoring projects.

### Acceptance criteria

1. A valid registration using an unused email address creates one account.
2. Registration using an email address already registered creates no
   duplicate account and returns a clear error.
3. Missing required fields or invalid input produces a validation error
   and creates no account.
4. Passwords are stored as secure, one-way hashes. Registration responses
   contain neither the password nor its hash.
5. Registration does not grant access to existing private projects.
   Access requires the appropriate project membership.

### Further stories and verification

**US-02:** As a user, I want to sign in, retrieve my account, and end a session so that authenticated access is revocable.

**US-03:** As an owner, I want to create a project and assign responder/viewer memberships so that teammates have appropriate access.

| ID | Given / action | Required result |
| --- | --- | --- |
| AC-01.1 | Valid/invalid registration and differently cased duplicate email | One normalized account at most; no credential material returned |
| AC-01.2 | Correct/incorrect password; missing, expired, or revoked token | Only a valid session grants access; logout prevents token reuse |
| AC-01.3 | User creates project | Project and creator's owner membership commit together |
| AC-01.4 | Owner invites member; responder/viewer attempts invitation | Owner succeeds within allowed roles; others fail without mutation; uniqueness and audit hold |
| AC-01.5 | User substitutes another project's resource ID | Every project-scoped route denies unauthorized access without private data leakage |
| AC-01.6 | Client requests owner/admin privilege through signup/invitation | Privilege escalation is rejected; existing owner is preserved |

## SP-02 — Service and check configuration

**US-04:** As an owner, I want to configure a service's endpoint, schedule, expected response, and thresholds so that monitoring observes the right behavior.

**US-05:** As an owner, I want to disable/archive a service or change visibility without losing its history.

| ID | Given / action | Required result |
| --- | --- | --- |
| AC-02.1 | Owner submits valid service settings | Configuration is saved with actor, timestamp, and revision |
| AC-02.2 | Unsafe URL, credentials, unsupported method/interval, or out-of-range values | Request fails validation and creates no usable unsafe configuration |
| AC-02.3 | Unauthorized role changes configuration | Mutation is denied |
| AC-02.4 | Owner changes configuration | Revision advances with audit; queued work cannot silently use a superseded configuration |
| AC-02.5 | Service is disabled/archived | Excluded from dispatch; queued work checks eligibility before sending HTTP |
| AC-02.6 | Service is private | Hidden from every public projection and unauthorized subscription selection |

## SP-03 — Scheduled health checks

**US-06:** As a member, I want due checks to run independently so one slow endpoint does not stop unrelated services.

**US-07:** As an operator, I want retryable durable jobs without duplicate authoritative observations.

| ID | Given / action | Required result |
| --- | --- | --- |
| AC-03.1 | Two schedulers see one due slot | One uniquely keyed durable job represents service/configuration/scheduled slot |
| AC-03.2 | Workers compete or a lease expires | One current lease owns completion; replaced owners cannot commit authoritative results |
| AC-03.3 | Endpoint succeeds, fails HTTP expectation, times out, or cannot connect | One result records observation time, latency, HTTP status if available, and sanitized failure |
| AC-03.4 | One endpoint is slow | Bounded concurrency and timeouts permit unrelated work to progress |
| AC-03.5 | Worker crashes or persistence fails and retries | Attempts are recorded; no duplicate result for the job |
| AC-03.6 | DNS answer changes or endpoint redirects | Actual connection destination remains validated/pinned; redirects cannot bypass SSRF protection |

A failed HTTP observation is a completed result. Infrastructure retries must not create multiple observations for one job. HTTP may be sent again after a crash; the guarantee is one authoritative stored outcome, not universal exactly-once network execution.

## SP-04 — Status calculation and history

**US-08:** As a member, I want evidence-based status and recovery thresholds so one temporary failure is not automatically an outage.

**US-09:** As a responder, I want an explained, expiring override that preserves calculated status and history.

| ID | Given / action | Required result |
| --- | --- | --- |
| AC-04.1 | Three consecutive failures under defaults | First/second failure is degraded; third reaches outage |
| AC-04.2 | Successes occur after outage | One success retains outage; two consecutive successes satisfy recovery |
| AC-04.3 | Outcomes alternate or are slow | Opposite outcomes reset consecutive counts; slow behavior follows documented degradation rules |
| AC-04.4 | No result, insufficient initial healthy evidence, or stale result | Unknown when applicable; old success does not stay operational indefinitely |
| AC-04.5 | Duplicate/older result is processed | Counters do not advance twice; late observations cannot overwrite newer state |
| AC-04.6 | Authorized override supplies reason and expiry | Effective status changes while calculated status continues; actor/time/reason retained |
| AC-04.7 | Override expires | Calculated status resumes, including stale unknown; history remains |

## SP-05 — Incidents and updates

**US-10:** As a responder, I want manual/outage-triggered incidents and timestamped updates so the team can investigate and communicate progress.

| ID | Given / action | Required result |
| --- | --- | --- |
| AC-05.1 | Manual creation or detected outage | Incident begins investigating; repeated outage processing cannot duplicate the episode's incident |
| AC-05.2 | Sequential lifecycle transition | Legal transition commits with actor/time and update evidence |
| AC-05.3 | Skipped/reversed or concurrent stale transition | Conflict fails without partially updating the incident |
| AC-05.4 | Public/private updates coexist | Anonymous output contains only explicitly public information for public services |
| AC-05.5 | Service recovers | No fabricated acknowledgement or automatic incident resolution |

## SP-06 — Alerts and acknowledgement

**US-11:** As a responder, I want one alert for a configured problem episode, reliable simulated delivery, and explicit acknowledgement.

| ID | Given / action | Required result |
| --- | --- | --- |
| AC-06.1 | Service enters configured problem state | One alert uses a unique episode/state deduplication key |
| AC-06.2 | Processing repeats concurrently | No duplicate alert; delivery attempts remain separate evidence |
| AC-06.3 | Simulated delivery fails then retries | Failure retained; only successful attempt marks delivery successful |
| AC-06.4 | Authorized responder acknowledges twice | Actor/time recorded safely without duplicate acknowledgement |
| AC-06.5 | Delivery fails or unauthorized user acknowledges | No automatic acknowledgement; unauthorized request makes no change |

## SP-07 — Public status, subscriptions, and simulated plans

**US-12:** As a visitor, I want safe public status/incident information without a project account.

**US-13:** As a visitor, I want selected-service subscriptions with simulated email verification.

**US-14:** As an owner, I want a simulated plan upgrade whose retries cannot activate it twice.

| ID | Given / action | Required result |
| --- | --- | --- |
| AC-07.1 | Anonymous public-status request | Only public, unarchived services, effective statuses, and permitted incident information |
| AC-07.2 | Public response is inspected recursively | No raw URLs, credentials, memberships, internal notes, private configuration, or hidden service identifiers |
| AC-07.3 | Visitor subscribes to public services | Pending subscription created; duplicate identity/selections cannot create duplicate active subscriptions |
| AC-07.4 | Valid, expired, invalid, or reused verification token | Valid token verifies once; invalid/expired fail; replay cannot verify a different subscription |
| AC-07.5 | Subscriber unverified or service becomes private | No verified-subscriber delivery or private-data leak |
| AC-07.6 | Simulated payment fails | Failure persists; current plan unchanged |
| AC-07.7 | Retry succeeds and successful request repeats | Plan activation commits once; attempt history retained |
| AC-07.8 | Idempotency key reused with conflicting input | Reject conflict instead of applying unrelated operation |

The original backend baseline allowed a small public status page. The final delivery also includes the requested team dashboard and a styled public experience. Simulation sends no real email and moves no real money, which responses and documentation must state.

## SP-08 — Reliability, audit, and administration

**US-15:** As an administrator, I want failure/retry records so background problems can be investigated.

**US-16:** As an authorized reviewer, I want important changes attributed to an actor and time.

| ID | Given / action | Required result |
| --- | --- | --- |
| AC-08.1 | Scheduler, worker, or delivery fails | Durable operation/resource/time/cause evidence, sanitized for secrets |
| AC-08.2 | Access, configuration, override, incident, acknowledgement, or plan changes | Audit identifies actor, action, project/resource, timestamp, safe metadata |
| AC-08.3 | Related writes cannot all succeed | Transaction rolls back partial effects; retry remains safe |
| AC-08.4 | Unauthorized administration request | Denied; project ownership does not grant platform administrator role |
| AC-08.5 | Logs, audit, and health output inspected | No secret/credential leakage or public database connection details |

## Integrated acceptance scenarios

| Scenario | Demonstration | Evidence |
| --- | --- | --- |
| Healthy endpoint | Registration → project → safe endpoint → scheduled results → operational | API responses, persisted results/history, integration test |
| Outage | Failures reach threshold → outage → one incident and alert | Threshold and duplicate/concurrent processing tests |
| Recovery | Consecutive successes reach recovery threshold | Test showing one success after outage is insufficient |
| Worker retry | Retry/competing worker processes same slot | One authoritative result and no duplicate incident/alert |
| Failed alert | Delivery fails then succeeds on retry | Attempt history; no false delivery/acknowledgement |
| Private service | Anonymous/unrelated user attempts access | Denial and safe public projection |
| Payment retry | Failure → unchanged plan → success → duplicate success | Exactly one activation and retained attempts |

## Cross-cutting requirements and limits

- Persistent storage needs explicit index/schema setup and repeatable migrations. Validation does not replace unique indexes or transactional invariants.
- Validate server-side, reject privilege-bearing mass assignment, bound request sizes/lists/concurrency/timeouts/retries, and use consistent sanitized errors and appropriate HTTP status codes.
- Store secrets in environment configuration; never commit them or include them in logs/examples/public output. Example configuration contains placeholders only.
- Test each important feature during development and record what the test proves. A mocked database alone cannot prove real transaction or concurrency behavior.
- Maintain README/setup, environment, migration, API, testing, architecture, limitations, and deployment documentation as work progresses.
- Exclude full APM, centralized logging platforms, infrastructure agents, SMS/telephone paging, real payments, multi-region runners, automatic remediation, custom domains, and DNS management.

## Frontend and final delivery criteria

These criteria capture the final request without changing the meaning of the original backend requirements.

| ID | Required result | Review method |
| --- | --- | --- |
| UI-01 | Account access, project selection, monitor management, incidents, alerts, members, plan simulation, and settings use the real API | Browser walkthrough and API integration tests |
| UI-02 | A consistent responsive interface uses clear typography, status colours, hover feedback, transitions, and restrained glow effects | Desktop and narrow-screen inspection |
| UI-03 | Forms have labels, keyboard focus remains visible, errors are understandable, and reduced-motion preferences are respected | Keyboard and reduced-motion browser review |
| UI-04 | Loading, empty, failed, unknown, paused, and live-data states communicate what actually happened | Empty-project, stopped-worker, and failed-request walkthroughs |
| UI-05 | Public presentation retains safe projections and supports the subscription flow without exposing private data | Public-route regression tests and anonymous browser review |
| DEL-01 | Setup, configuration, architecture, workflow, API, deployment, and limitations match the final implementation | Documentation review and link check |
| DEL-02 | Every SP/AC identifier remains traceable; final checks and demo evidence are recorded honestly | Matrix below and final delivery report |
| DEL-03 | Demonstration and presentation explain the full workflow, failure behavior, and the six-week progression | Final demo and presentation guide |
| DEL-04 | Generated output, credentials, local databases, dependency directories, and temporary tooling stay outside the submission | Ignore rules and repository status review |

## Implementation and verification map

Use this table to locate the evidence rather than treating it as a blanket pass. Test names describe the behavior being exercised; the dated [verification record](final-delivery.md#verification-record) states which commands actually completed. Source paths are relative to the repository root.

Test groups: **API** = [api.test.ts](../tests/api.test.ts), **Business** = [business.test.ts](../tests/business.test.ts), **Monitoring** = [monitoring.test.ts](../tests/monitoring.test.ts), **Endpoint** = [endpoint-checker.test.ts](../tests/endpoint-checker.test.ts), **Startup** = [startup-error.test.ts](../tests/startup-error.test.ts), **Browser** = [workflows.spec.ts](../tests/browser/workflows.spec.ts). The integrated [demo](../scripts/demo.ts) uses controlled outcomes and an isolated replica set.

| Requirement / acceptance criteria | Implementation | Relevant verification |
| --- | --- | --- |
| SP-01 / AC-01.1, AC-01.2 | `auth-routes.ts`, `core.ts`, session/email indexes in `db.ts` | API account validation, normalization, password/token hashing, login failure, expiry, and logout |
| SP-01 / AC-01.3, AC-01.4 | `project-routes.ts`, transactional project/membership creation, invitations | API project membership, invitation reissue/expiry, roles, and project creation; transaction review |
| SP-01 / AC-01.5, AC-01.6 | Scoped membership middleware, strict schemas, separate admin provisioning | API cross-project isolation and signup mass assignment; Business outsider denial; no owner-grant invitation schema |
| SP-02 / AC-02.1, AC-02.3, AC-02.4 | `service-routes.ts`, immutable `serviceVersions`, audit and revision conditions | API configuration validation, role denial, preserved PATCH values, stale/concurrent edits; Monitoring configuration changes during execution |
| SP-02 / AC-02.2 | Service schema and `endpoint-checker.ts` | API unsafe URL/range/plan validation; Endpoint literal, DNS, protocol, credential, redirect, and deadline tests |
| SP-02 / AC-02.5 | Service archival; scheduler and pre-execution eligibility checks | API archival preserves history and denies disabled manual checks; Monitoring queued ineligible-job regression |
| SP-02 / AC-02.6 | `public-routes.ts`, public HTML projection, subscription validation | Business public visibility, hidden IDs, and private subscription selections |
| SP-03 / AC-03.1 | `monitoring.ts`, unique job dispatch key in `db.ts` | Monitoring concurrent schedulers and missed-slot coalescing |
| SP-03 / AC-03.2 | Conditional lease claims and completion fencing | Monitoring parallel workers and expired-lease replacement |
| SP-03 / AC-03.3, AC-03.6 | `endpoint-checker.ts`, immutable check results | Endpoint DNS pinning, safe TLS hostname, failures, redirects, timeout, and response-body bounds |
| SP-03 / AC-03.4 | Worker concurrency and per-check deadline | Monitoring slow/fast job independence; Endpoint deadline tests |
| SP-03 / AC-03.5 | Retry attempts, bounded backoff, failed-job reaping, unique result key | Monitoring internal failures, replacement leases, final crashed lease, and transactional rollback |
| SP-04 / AC-04.1, AC-04.2, AC-04.3 | `calculateStatus` and persisted counters in `monitoring.ts` | Monitoring initial health, failure threshold, partial recovery, slow success, and counter reset |
| SP-04 / AC-04.4, AC-04.5 | `effectiveStatus`, observation ordering, stale maintenance | Monitoring unknown/stale state, parallel result prevention, and late observations |
| SP-04 / AC-04.6, AC-04.7 | Service override routes and expiry/history maintenance | API override roles/expiry/privacy; Monitoring underlying failure counting and expiry audit |
| SP-05 / AC-05.1 | `incident-routes.ts`, automatic outage creation, active-incident index | Business one active incident; Monitoring automatic/manual incident deduplication |
| SP-05 / AC-05.2, AC-05.3 | Incident lifecycle/version transaction and update records | Business sequential lifecycle, skipped transition denial, and concurrent versions |
| SP-05 / AC-05.4, AC-05.5 | Safe incident/update projection; recovery evidence without resolution | Business public/internal update separation; Monitoring partial recovery and unresolved incidents |
| SP-06 / AC-06.1, AC-06.2 | Alert deduplication keys and `delivery.ts` | Monitoring outage alert count; Business concurrent delivery |
| SP-06 / AC-06.3 | Durable delivery attempts, bounded automatic retry, authorized explicit retry | Business failed delivery, retry history, exhaustion, and disabled simulation |
| SP-06 / AC-06.4, AC-06.5 | Role-gated conditional acknowledgement | Business idempotent/concurrent acknowledgement and viewer denial; failed delivery remains unacknowledged |
| SP-07 / AC-07.1, AC-07.2 | `public-routes.ts` allowlists and escaped public presentation | Business service/incident/history privacy; API HTML escaping and disabled public project |
| SP-07 / AC-07.3, AC-07.4 | Subscription uniqueness, token hashes, expiry, verification | Business normalized/concurrent subscriptions, single verification, replay, and production expiry |
| SP-07 / AC-07.5 | Selection/visibility recheck during notification | Business unverified/private-service non-delivery and selected-service deduplication |
| SP-07 / AC-07.6, AC-07.7, AC-07.8 | Transactional simulated payment and unique project/idempotency key | Business failed payment, concurrent success, replay, conflicting input, and disabled simulation |
| SP-08 / AC-08.1 | Operational events, attempts, worker heartbeats, startup diagnostics | Monitoring exhausted checks; Business delivery attempts; Startup safe diagnostics |
| SP-08 / AC-08.2 | Audit writes inside domain transactions; project/admin audit routes | API configuration/permissions; Monitoring override/lease failure audit; Business single plan activation |
| SP-08 / AC-08.3 | `transaction` helper, conditional writes, indexes | Monitoring injected later-write failure and full rollback; Business payment/incident race invariants |
| SP-08 / AC-08.4, AC-08.5 | Separate platform role, safe errors/health/startup logging | API unauthorized administration and health; Startup redaction of credentials, input, and database documents |
| UI-01–UI-05 | `public/`, dashboard routes, safe public page | API asset/privacy tests; Browser owner, membership, public subscription/privacy, mobile/reduced-motion, and failed-load/expiry workflows |
| DEL-01–DEL-04 | README, `docs/`, scripts, deployment and ignore files | Documentation review, final check/demo commands, repository review |

## Delivery status

The [final delivery report](final-delivery.md) separates implementation, executed checks, browser review, and external deployment. A written requirement, existing test, or deployment manifest alone does not prove that its execution passed. The available baseline is this repository; any separate institutional marking rubric should be checked against it before submission.

## Production account and email extension

| ID | Requirement | Verification |
| --- | --- | --- |
| EXT-01 | Real invitations, account verification, recovery and public notifications use a durable Resend outbox; disabled email never claims success | Email and authentication integration tests |
| EXT-02 | Provider failures are retried with bounded attempts and stable idempotency keys; acceptance is distinct from inbox delivery | Outbox concurrency, failure, expiry and provider-response tests |
| EXT-03 | Google/GitHub sign-in validates state, browser binding and verified identity; existing manual accounts link explicitly | OAuth callback, token validation, account-collision and session tests |
| EXT-04 | One-use reset and verification links expire; password resets invalidate existing sessions | Authentication tests |
| EXT-05 | Light/dark/system themes persist; password visibility is accessible; creator credit is configurable | Browser preference and responsive checks |
| EXT-06 | Public subscription email proves mailbox control; unsubscribe and visibility changes suppress later notifications | Email integration and public workflow tests |
| EXT-07 | Provider activation instructions are exact and secrets stay outside Git | Configuration tests and connection guide |

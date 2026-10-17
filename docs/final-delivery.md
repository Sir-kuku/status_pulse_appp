# Final delivery: weeks 1–6

For the latest account, email and appearance improvements, read [the product extension](#account-email-and-appearance-extension) below and the [provider connection guide](email-and-sign-in-setup.md).

Status Pulse now connects the monitoring engine to a usable team dashboard and public status page. This report records the original six-week delivery, how to demonstrate it, and its verification limits. A subsequent product extension adds real email, Google/GitHub identity, themes and password visibility; see [connection and activation](email-and-sign-in-setup.md). Original simulation descriptions below refer to the coursework demonstration mode.

## The six-week progression

| Week | Delivered work |
| --- | --- |
| 1 | Requirements, acceptance criteria, permissions, architecture, data model, and API design |
| 2 | Account sessions, project roles, monitor configuration, durable scheduling, and safe HTTP checks |
| 3 | Status thresholds, check history, temporary overrides, and incident lifecycle |
| 4 | Alerts, acknowledgement, public status, verified subscription simulation, plan simulation, and integration |
| 5 | Failure and concurrency regressions, worker eligibility checks, bounded delivery retries, responsive frontend, and browser checks |
| 6 | Final review, updated documentation, complete workflow overview, acceptance demonstration, and presentation material |

The requirements in this repository are the review baseline. [Every SP/AC identifier is mapped to implementation and verification](requirements.md#implementation-and-verification-map). A separate institutional rubric was not present in the workspace.

## What changed in the final pass

The dashboard now supports account access, project switching, monitor creation and edits, recent checks, response charts, status history, overrides, incident updates, alert failure/retry, acknowledgement, invitations, member role changes and removal, payment failure/retry, audit review, and archival. Owners can inspect saved configuration versions. Platform administrators have an Operations view.

The public page uses the same visual system and supports service selection, simulated subscription verification, public incident timelines, and status history. The API reference also has a readable styled layout. Empty, loading, failed, unknown, and paused states explain what has happened without inventing monitoring data.

The interface uses responsive layouts, visible keyboard focus, a mobile navigation drawer, hover feedback, restrained glows, and short transitions. Reduced-motion preferences disable animation and transitions. No external font or image service is needed to render the interface.

The reliability review closed several concrete gaps:

- Queued work for a disabled, archived, removed, or reconfigured monitor is cancelled before contacting the endpoint. It creates no invented check result.
- Recovery evidence requires the configured successful-check threshold, including after configuration resets.
- Automatic alert attempts stop after three failures. Authorized responders can still retry explicitly; successful delivery clears the exhaustion marker.
- Regressions verify slow/fast worker independence and a real MongoDB transaction rollback after a later write is rejected.

## Verification record

This section records the original six-week release. The provider and appearance extension is recorded separately below.

Verification date: **17 October 2026 (Africa/Lagos)**. These results came from the completed local runs, not estimates or previous CI results.

| Check | Result |
| --- | --- |
| TypeScript and browser JavaScript validation | Passed: `npm run typecheck` and `npm run check:frontend` |
| OpenAPI contract | Passed: all 40 documented paths validated |
| Backend regression suite | Passed: 47 tests, 0 failures or skips |
| Production compilation | Passed: `npm run build` |
| Browser workflows | Passed: 5 scenarios in Chrome, 0 failures or skips |
| Deterministic acceptance demonstration | Passed: all 10 scenarios |
| Requirements and documentation review | All 48 original acceptance criteria mapped; local links in all 6 Markdown documents resolve |
| Visual review | Desktop account access, dashboard and public status, plus 390px mobile dashboard inspected |
| Hosted API and independent worker | Not verified in this delivery |
| Local Docker image / Compose runtime | Not executed in this delivery |

The browser suite uses Chrome on Windows by default and Playwright Chromium elsewhere. It starts an isolated MongoDB replica set and a test API on `127.0.0.1:3107`; a controlled checker supplies successful outcomes without probing external services. This proves browser/API integration, not the availability of an external endpoint. The backend network tests exercise URL validation, DNS handling, redirects, deadlines, and controlled failure conditions separately.

Run the final checks:

```powershell
npm ci
# On a machine without the selected browser, install Playwright Chromium:
npx playwright install chromium
npm run verify
```

On Windows, the default is installed Google Chrome. To use Playwright's installed Chromium instead, set `$env:PLAYWRIGHT_CHANNEL = 'chromium'` before the command. On CI, the workflow installs Chromium and its system dependencies. Browser configuration follows the official [Playwright browser guidance](https://playwright.dev/docs/browsers) and [test web-server lifecycle](https://playwright.dev/docs/test-webserver).

Generated evidence stays under `.local/verification/`: `check.log`, `demo.json`, `browser-results.json`, and representative desktop/mobile screenshots. Failure traces go to `.local/browser-results/`. These artifacts are ignored by Git; keep selected copies with an assessment submission when needed. The updated GitHub Actions workflow includes backend, browser, acceptance-demo, Compose configuration, and container-build checks, but this revision's remote CI run has not been verified.

The five browser scenarios cover the owner journey from registration through monitoring, incident resolution, alert delivery/acknowledgement, payment failure/retry, and archival; membership management and viewer restrictions; public subscriptions and private-data/script-injection protection; mobile navigation and reduced motion; and failed-load retry plus expired-session handling. These are focused workflow checks, not a claim of exhaustive browser or accessibility certification.

## Demonstration walkthrough

Allow about 10–12 minutes. Start `npm run local`, open `http://localhost:3000/`, and keep the deterministic demo report ready. Use a fresh project so the audience can follow the setup.

1. **Introduce the problem.** Explain that knowing a service failed is only the start: the team also needs a response timeline and a clear public update.
2. **Create the workspace.** Register an account, create a project, and add a public endpoint. Show the interval, failure/recovery thresholds, and public-visibility control. Explain the initial unknown status.
3. **Show evidence.** Wait for recorded checks, or queue a check. Open details, point out the response chart and history, then edit the monitor and show its saved configuration versions. Network results depend on the endpoint; use `npm run demo` for repeatable failure evidence.
4. **Demonstrate an incident.** Report an incident and post investigating, identified, monitoring, and resolved updates. Explain why a successful check does not automatically resolve it.
5. **Separate delivery from responsibility.** Show an alert and its delivery state, then acknowledge it. The isolated browser suite and acceptance report provide deterministic failure/retry evidence when the live worker has already delivered the alert.
6. **Show permissions.** Invite a viewer using a separate account/browser context. Show that the viewer can inspect information but cannot change configuration. Return to the owner to change or remove membership.
7. **Open the public page.** Show that private URLs and internal notes are absent. Subscribe to selected services and complete the simulated verification. Explain that no real email is sent.
8. **Demonstrate a payment retry.** Choose a failed advanced-plan simulation, show that the plan stays free, then retry it from payment history. Show the advanced interval option and explain idempotency.
9. **Explain reliability.** Use the deterministic report and regression tests to show concurrent workers, safe retries, stale evidence, and rollback. If an administrator has been provisioned, show worker health and audit events.
10. **Finish with scope and evidence.** Show the requirements map and verification results. State that real provider integrations and actual hosted verification are separate from the demonstrated local implementation.

Avoid claiming that a controlled test outcome came from a live website. If a real endpoint is unavailable during the presentation, that is an opportunity to show the unknown/degraded states and explain the saved evidence.

## Presentation outline

| Slide | Main point | Suggested evidence |
| --- | --- | --- |
| 1 — The problem | Teams need service visibility, a response process, and clear communication | One realistic service outage example |
| 2 — Who uses it | Owners, responders, viewers, visitors, and administrators have different responsibilities | Role matrix |
| 3 — The architecture | One codebase runs an API and an independent worker against a replica set | Workflow diagram |
| 4 — Monitoring rules | Checks are evidence; thresholds and stale handling produce status | Monitor details and state examples |
| 5 — Incident response | Recovery, delivery, acknowledgement, and resolution are different facts | Incident timeline and alert inbox |
| 6 — Public communication | Only explicitly public information reaches visitors | Public page and subscription form |
| 7 — Reliability and security | Leases, indexes, transactions, scoped roles, and safe outbound requests protect invariants | Selected regression results |
| 8 — Final delivery | Weeks 5–6 complete the interface, review, documentation, and demonstration | Verification table and honest deployment boundary |

Useful answers during questions: MongoDB needs a replica set for transactions; a transaction cannot undo an HTTP request; the worker runs independently of page views; a public URL is checked again before network use; and simulation settings are not real provider integrations.

## Account, email and appearance extension

The invitation issue came from the original coursework simulation: it created an invitation record without contacting an email service. The product extension adds a Resend-backed queue for team invitations, account verification, password recovery, password-change notices, subscription confirmation and public incident updates. Production email stays unavailable until a real sender and key are configured. Development demonstrations remain explicitly labelled.

Messages have durable delivery attempts, bounded retries and a stable provider idempotency key. A successful API response is recorded as **sent to provider**, rather than claiming inbox delivery. Queued messages are checked again before sending; expired or superseded links, revoked subscriptions and private services cannot produce stale notifications. Owners can inspect project email activity without seeing secret link tokens. Email processing runs independently of monitoring checks.

Google and GitHub can create accounts and sign users in once their credentials are configured. Existing manual accounts connect a provider explicitly from **Your account**. Browser-bound OAuth state, PKCE and verified provider identity protect that flow. Resetting a password consumes a one-use link and invalidates existing sessions, including sessions created concurrently with the reset. Old simulated verification cannot become proof of real mailbox ownership.

Light, dark and system appearance work throughout the dashboard, account screens, public pages and API documentation. The browser remembers the preference. Password eye buttons support keyboard use, and the footer credits **Designed & built by Sir. Kuku**, with an operator-configurable name and link. Email links work both on a fresh page and in an already open tab.

### Extension verification

Verified locally on **17 October 2026**:

| Check | Result |
| --- | --- |
| Complete backend regression suite | 73 passed, including authentication/email cases covering signed Google token validation, explicit provider linking, session revocation, real-mode email retries, migration from simulation, unsubscribe and consistent email defaults |
| Browser workflows | 13 passed across account, preferences and existing-workflow suites; includes mobile theme persistence, password visibility, invitation links, recovery availability, transient connection failures, public verification and project-role controls |
| Deterministic acceptance demonstration | All 10 scenarios passed |
| Build, frontend syntax and API contract | Passed; 51 documented API paths |
| Documentation review | Seven Markdown files checked; local links resolve and the original 48 acceptance criteria remain mapped |
| Visual inspection | Light account screen, dark mobile account screen, dark account dialog and dark public status page inspected |
| Local runtime | Updated persistent local stack restarted; database readiness returned ready |
| Live provider delivery and OAuth consent | Awaiting the owner's provider accounts and credentials; tests use controlled provider responses |

The [connection guide](email-and-sign-in-setup.md) gives the exact callback URLs and Render settings for the current website. It also explains how to verify a real received invitation, a password reset, Google/GitHub sign-in and an unsubscribe. Source-code completion does not substitute for those live provider checks.

The recovery follow-up makes unconfigured email consistent locally and on Render. Simulation now requires an explicit development setting, and the reset dialog explains it before accepting a request. When email is disabled, the dialog does not offer a send action. Temporary failures while loading sign-in options are retried and shown separately from missing provider configuration.

## Submission and handover

Keep source, tests, package manifests and lockfile, deployment configuration, API contract, and documentation. Exclude `.env`, credentials, `node_modules`, compiled `dist`, local databases, temporary scripts, logs, and generated browser reports. Existing local files do not need deletion to keep them out of the repository.

Review the selected evidence for tokens or credentials before sharing it. The final deployment gate is to run the [hosted checks](deployment.md) against the intended revision and record the actual URL, readiness, persisted worker results, and restart behavior. This delivery does not create a paid service or claim a live deployment.

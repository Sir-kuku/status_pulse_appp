# Status Pulse: architecture and design decisions

This document began with the week 1 analysis and now explains the final design. The original question has stayed the same: how can a small team monitor its services, investigate failures, and communicate clearly without losing the evidence behind a status?

The [requirements](requirements.md) define the expected behavior. The [workflow overview](workflow-overview.md) follows a user's journey through the system. This document explains why the application is structured this way and where its guarantees stop.

## One application, two processes

Status Pulse uses Node.js 24, TypeScript, Express 5, and the native MongoDB driver. The browser dashboard is served by Express and calls the same API as other clients. A separate scheduler/worker handles outbound HTTP checks and simulated alert delivery.

This keeps normal page requests independent of monitoring intervals. The worker can restart without restarting the website, and the website can restart while durable jobs remain in MongoDB. Both processes use the same application code and database.

| Component | Responsibility | Reason for the choice |
| --- | --- | --- |
| HTML, CSS, and browser JavaScript | Dashboard, forms, charts, and interaction | Direct API integration with a small runtime and no separate frontend build |
| Express API | Authentication, permissions, validation, safe responses | A focused HTTP layer with explicit domain modules |
| TypeScript | Request, configuration, and state contracts | Makes the rules easier to inspect; runtime schemas still validate external input |
| MongoDB replica set | Documents, indexes, conditional updates, transactions | Related writes can succeed or fail together |
| Scheduler/worker | Reserve due work, claim jobs, check endpoints, record outcomes | Slow network requests do not occupy API handlers |
| Simulated delivery | Record attempts, retry failures, and expose a protected demo inbox | Demonstrates reliability without a real email or payment provider |

A dedicated queue would provide more mature queue operations, but it would add another service to run and explain. The MongoDB-backed queue keeps this project focused; it also means that leases, retry limits, and recovery behavior must be implemented and tested here.

## The important flows

A private request is parsed, authenticated, checked against current project membership, validated, and handled. Knowing a resource ID does not grant access: the resource must belong to the project and the caller must have the required role. Related writes are committed before a safe response is returned.

A monitoring cycle reserves a due slot, creates a uniquely identified job, claims a lease, rechecks the current service settings, validates the destination, and sends a timed GET or HEAD request. The network request happens outside the database transaction. A transaction cannot undo an HTTP request, and a slow endpoint must not hold a database transaction open.

When the result is ready, one transaction records the observation, advances the current status when appropriate, writes history, creates any incident/alert effects, and completes the job. A failed transaction leaves no partial authoritative result.

Alert delivery records whether a simulated attempt succeeded. Acknowledgement records that a person has taken responsibility. Neither implies the other. Payment simulation follows a similar rule: a failed attempt stays in history, a successful retry changes the plan once, and a repeated success returns the existing outcome.

## Identity and permissions

Passwords use salted scrypt hashes. Sessions use random bearer tokens: the client receives the token, while the database stores its hash, account, expiry, and revocation state. A session normally lasts 24 hours. Logout revokes it immediately, and authentication checks expiry even before database cleanup runs.

Membership is a relationship between a person and a project. A person may own one project, respond in another, and only view a third. Owners configure the project and invite responders or viewers. Responders manage operational work. Viewers can inspect the project. The [role matrix](requirements.md#actors-and-permission-boundaries) lists each boundary.

An invitation is tied to an email address and a one-use, expiring token. The invited account must authenticate with that address. Reissuing an invitation invalidates the older token. Invitations cannot create owners or platform administrators. An operator provisions platform administrators separately; that role does not grant automatic membership in private projects.

## Data model

The collections follow the business facts that need independent history, queries, or uniqueness. Current counters and the active override are bounded fields on a service. Check results, incident updates, delivery attempts, and audit events have their own records because their histories grow over time.

| Data | What it represents | Important constraint |
| --- | --- | --- |
| Users and sessions | Identity and revocable access | Unique normalized email; hashed passwords/tokens; checked expiry |
| Projects and memberships | Workspace and project roles | Project/creator membership created together; unique project/user membership |
| Invitations | A pending membership offer | Email-bound, expiring, one-use token; limited roles |
| Services and service versions | Current monitor settings and immutable revisions | Owner-only configuration; revision checks; due-work index |
| Check jobs | Durable scheduled or manual work | Unique dispatch identity; attempts and current lease |
| Check results | Observed HTTP outcome and timing | One authoritative result per job |
| Status history | Effective status changes and their explanation | Retained through overrides and archival |
| Incidents and updates | Investigation and communication | One active incident per service; ordered versioned transitions |
| Alerts and delivery attempts | Problem notification and each simulated delivery | Unique problem key; delivery and acknowledgement separate |
| Subscriptions and notifications | Selected public services and public updates | Normalized identity, token verification, current visibility recheck |
| Payments | Simulated plan operation and attempt history | Unique project/idempotency key; one activation |
| Audit and operational events | Who changed something, or why work failed | Safe metadata with actor/resource/time where applicable |
| Worker heartbeats | Recent background-process activity | Independent from API readiness |
| Simulated mail | Protected demonstration tokens | Owner-only access and automatic expiry |

Historical resources are archived. Archiving a service stops new scheduling and public exposure without erasing its checks or incidents. Token expiry cleanup is housekeeping; business retention and account erasure would need a separate policy.

## Reliability guarantees

Unique indexes prevent duplicate identities and authoritative records even when two requests arrive together. Transactions keep related writes consistent. Conditional revision checks prevent stale edits. Leases identify the worker currently allowed to complete a job; a replaced lease cannot later commit its result.

These controls work together:

1. One service/configuration/scheduled slot produces one durable job.
2. One current lease may complete that job.
3. One job has at most one authoritative stored result.
4. An older observation cannot replace newer current status.
5. One problem episode does not create repeated automatic incidents and alerts.
6. Infrastructure and delivery retries are bounded, visible, and preserve failed attempts.
7. One successful simulated payment activates the plan once.

A worker can crash after sending HTTP and before saving the result. Another worker may send the request again. GET/HEAD and idempotent persistence make that manageable, but the guarantee remains one authoritative stored outcome rather than exactly-once network execution.

## Status is evidence; an incident is a decision

With no completed check, the service is unknown. Under the defaults, two successful checks establish operational status. Failures produce degraded status until the third consecutive failure reaches outage. A single success during an outage does not clear it; two consecutive successes are needed. A slow successful response can still be degraded.

Opposite outcomes reset the relevant consecutive counter. Old or duplicate observations do not advance counters. Evidence becomes stale after `max(three intervals, timeout plus interval)`; with the allowed settings this is three intervals. Stale evidence is unknown even if the last result was healthy.

A responder may temporarily override the displayed status with a reason and expiry. Monitoring continues, and calculated status remains separate. Expiry restores the calculated status, including unknown when evidence is stale.

Incidents move through investigating → identified → monitoring → resolved. Updates may stay in the current state or move to the next one; they cannot skip or reverse the lifecycle. A successful check does not make a responder's decision for them, so recovery adds evidence while the incident remains open.

## Network safety and public information

An endpoint monitor can otherwise become a way to reach internal services. Status Pulse restricts requests to GET/HEAD and public HTTP/HTTPS addresses, rejects credentials in URLs, validates every DNS answer, pins the approved connection address, keeps HTTPS hostname verification, blocks redirects, and bounds the total request time. It does not retain arbitrary response bodies.

Safety is checked again at execution because DNS and configuration can change. Tests use controlled resolvers/transports to exercise these rules without weakening production checks for localhost. Hosting-level egress controls can add protection, but application code alone does not establish those controls.

Public serializers select allowed fields explicitly. The project must be public, the service must be public and unarchived, and incident updates must be public. Endpoint URLs, internal notes, memberships, tokens, and configuration are excluded. HTML escapes user-supplied names and text. Subscription delivery checks visibility again so a formerly public service cannot keep leaking updates.

## Frontend decisions

The dashboard keeps navigation and feedback consistent across monitoring, incidents, alerts, members, plans, and settings. Charts and status summaries come from API records. Empty, unknown, and paused states communicate missing or inactive monitoring rather than inventing activity.

CSS supplies the visual hierarchy, responsive layouts, hover feedback, focus states, transitions, and glow effects. Reduced-motion preferences must keep the same functionality without decorative movement. Forms use explicit labels and visible errors; API authorization remains authoritative even when controls are hidden for a role.

## Verification and limits

The test suite uses real isolated MongoDB replica sets for transaction, unique-index, concurrency, and permission behavior. Controlled network transports cover success, HTTP failure, DNS failure, timeout, redirects, and unsafe destinations. The deterministic demo connects the major features into a repeatable story; the browser review checks the actual interaction and layout.

The final week adds targeted regressions for failures found during review, rather than relying on a successful happy-path demo. The [requirements map](requirements.md#implementation-and-verification-map) and [delivery report](final-delivery.md) make those checks traceable.

The local single-node replica set is not highly available. The application does not send real email, prove mailbox ownership, or process payments. There is no multi-region runner, full APM, automatic remediation, or established backup/restore service. Deployment manifests are supplied; live deployment and recovery evidence must be recorded separately.

# Internal data and module contracts

All modules import shared helpers from `src/core.ts`. This reference records the data shared by API routes and background processing.

`AppContext` supplies native MongoDB `client`, `db`, validated `config`, and injectable `now()`. Every document has ObjectId `_id`; references are ObjectIds. Routes serialize IDs using MongoDB's JSON representation. Auth routes populate `res.locals.user` using `requireUser(ctx)`. `actor(res)` returns the principal. `projectAccess(ctx,req,res,roles)` enforces project membership and role and returns a project. `serviceInProject` verifies nested service ownership. `transaction(ctx,session=>...)` supplies a session. `audit(ctx, session, {action,actorId,projectId,resourceId,metadata})` writes history, without credentials or URLs.

## Stored document conventions

- project: name, slug, ownerId, publicEnabled=false, plan='free'|'advanced', createdAt; optional archivedAt.
- membership: projectId,userId,role='owner'|'responder'|'viewer'.
- service: projectId,name,url,method='GET'|'HEAD',intervalSeconds,timeoutMs,expectedStatusMin,expectedStatusMax,slowThresholdMs,failureThreshold,recoveryThreshold,enabled,publicVisible,configVersion,nextCheckAt,calculatedStatus='unknown' initially,failureStreak=0,successStreak=0,createdAt,updatedAt; optional lastCheckedAt,lastProcessedDueAt,override={status,reason,expiresAt,actorId},archivedAt.
- checkJobs: serviceId,projectId,slot(unique per service),dueAt,configVersion,config snapshot,state='ready'|'leased'|'done'|'failed',availableAt,attempts,createdAt; optional leaseToken,leaseUntil. The monitoring module controls job transitions.
- checkResults: unique jobId, serviceId, projectId,checkedAt,dueAt,success,httpStatus,latencyMs,failureReason,configVersion,applied.
- statusHistory: serviceId,projectId,from,to,reason,createdAt,jobId optional.
- incident: projectId,serviceId,title,state='investigating'|'identified'|'monitoring'|'resolved',active:boolean,publicVisible:boolean,createdAt,updatedAt,createdBy:ObjectId|null,source='manual'|'monitor',version:number. Unique active incident per service (manual or automatic).
- incidentUpdate: incidentId,projectId,serviceId,message,state,publicVisible,createdAt,createdBy:ObjectId|null.
- alert: projectId,serviceId,incidentId,dedupeKey,kind='outage',deliveryState='pending'|'failed'|'delivered',attempts=0,createdAt; optional deliveredAt,acknowledgedAt,acknowledgedBy,lastError,nextAttemptAt. Simulated delivery must have durable attempts and exactly-once recorded delivery (not real SMTP).
- alertAttempt: alertId,attempt,outcome='failed'|'delivered',createdAt; optional reason.
- subscription: projectId,email,serviceIds:ObjectId[],verifiedAt optional,verificationTokenHash,verificationExpiresAt,createdAt. Public verification token may only be exposed by the explicit development simulation flow; no arbitrary public list of subscriber emails.
- notifications: subscriptionId,eventKey,projectId,serviceId,type,createdAt,deliveryState='delivered' for simulated subscriber email. Deduped per event/subscriber.
- payment: projectId,idempotencyKey,plan='advanced',state='failed'|'succeeded',attempts,createdAt,updatedAt. Repeating succeeded key cannot reactivate/recharge; failed key can retry success; success and plan change/audit share transaction. No money is charged.

## Module interfaces

- `core/config/db` define shared validation, authorization, transaction helpers, environment parsing, connections, and index migration. `auth/project/service` route modules implement their corresponding API resources. `app/server/worker` assemble the two runtime processes.
- `monitoring.ts` and `endpoint-checker.ts` export `validateEndpointUrl(input:string):URL` (syntax/IP checks), `checkEndpoint(config):Promise<CheckOutcome>`, `scheduleDue(ctx):Promise<number>`, `runNextCheck(ctx, checker?):Promise<boolean>`, `enqueueManualCheck(ctx,service,actorId):Promise<Document>`, and `expireOverridesAndRecordStale(ctx):Promise<void>`. `CheckOutcome` has success:boolean,httpStatus:number|null,latencyMs:number,failureReason:string|null. The worker persists result/status/history/automatic incident/outage alert atomically. An injected checker enables deterministic isolated tests; production uses the network checker.
- `incident-routes.ts`, `public-routes.ts`, and `delivery.ts` export `incidentRouter(ctx):Router` (mounted at /api/projects), `publicRouter(ctx):Router` (mounted at /api/public), and `deliverPendingAlerts(ctx, options?):Promise<number>`. The incident router requires authentication. Public projections explicitly allow safe fields. `notifyPublicIncidentUpdate` is shared with monitoring to record deduplicated simulated subscriber deliveries.

All destructive service/project operations archive instead of deleting history. Use strict Zod schemas. Wrap multiple related writes in a transaction. Never parallelize operations inside a transaction. List limits default50/max100. No plaintext credentials in logs/audits/public payloads. Existing private services must never appear through public routes even if their incident is marked public. Simulation failures are explicitly requested by authenticated owner/responder test flows; don't let anonymous callers alter team alert delivery.

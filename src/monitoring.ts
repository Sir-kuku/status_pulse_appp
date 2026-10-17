import { ObjectId, type ClientSession, type Document } from 'mongodb';
import { audit, effectiveStatus, fail, token, transaction, type AppContext, type ServiceStatus } from './core.js';
import { checkEndpoint, type CheckConfig, type CheckOutcome } from './endpoint-checker.js';
import { notifyPublicIncidentUpdate } from './delivery.js';

const MAX_ATTEMPTS = 3;
const LEASE_MS = 120_000;
type Checker = (config: CheckConfig) => Promise<CheckOutcome>;
function snapshot(service: Document): CheckConfig {
  return { url: service.url, method: service.method, timeoutMs: service.timeoutMs,
    expectedStatusMin: service.expectedStatusMin, expectedStatusMax: service.expectedStatusMax };
}
function jobFor(service: Document, slot: string, dueAt: Date, now: Date): Document {
  return { _id: new ObjectId(), serviceId: service._id, projectId: service.projectId, slot, dueAt,
    configVersion: service.configVersion, config: snapshot(service), state: 'ready', availableAt: now,
    attempts: 0, createdAt: now };
}

/** Schedule one check for a due service, coalescing missed intervals after downtime. */
export async function scheduleDue(ctx: AppContext): Promise<number> {
  const now = ctx.now();
  const candidates = await ctx.db.collection('services').find({ enabled: true, archivedAt: { $exists: false }, nextCheckAt: { $lte: now } })
    .sort({ nextCheckAt: 1, _id: 1 }).limit(100).toArray();
  let count = 0;
  for (const candidate of candidates) {
    count += await transaction(ctx, async session => {
      const service = await ctx.db.collection('services').findOne({ _id: candidate._id, enabled: true, archivedAt: { $exists: false }, nextCheckAt: { $lte: now } }, { session });
      if (!service) return 0;
      const project = await ctx.db.collection('projects').findOne({ _id: service.projectId, archivedAt: { $exists: false } }, { session });
      if (!project) return 0;
      const dueAt = new Date(service.nextCheckAt);
      const interval = service.intervalSeconds * 1000;
      const nextCheckAt = new Date(dueAt.getTime() + (Math.floor((now.getTime() - dueAt.getTime()) / interval) + 1) * interval);
      // Write the service first: concurrent schedulers conflict and retry before inserting the unique slot.
      await ctx.db.collection('services').updateOne({ _id: service._id }, { $set: { nextCheckAt } }, { session });
      const job = jobFor(service, `scheduled:${dueAt.toISOString()}`, dueAt, now);
      const result = await ctx.db.collection('checkJobs').updateOne({ serviceId: service._id, slot: job.slot }, { $setOnInsert: job }, { upsert: true, session });
      return result.upsertedCount;
    });
  }
  return count;
}

export async function enqueueManualCheck(ctx: AppContext, original: Document, actorId: ObjectId): Promise<Document> {
  return transaction(ctx, async session => {
    const service = await ctx.db.collection('services').findOne({ _id: original._id, archivedAt: { $exists: false } }, { session });
    if (!service) return fail(404, 'NOT_FOUND', 'Service not found.');
    if (!service.enabled) return fail(409, 'SERVICE_DISABLED', 'Enable the service before requesting a check.');
    const project = await ctx.db.collection('projects').findOne({ _id: service.projectId, archivedAt: { $exists: false } }, { session });
    if (!project) return fail(404, 'NOT_FOUND', 'Project not found.');
    const now = ctx.now();
    const job = jobFor(service, `manual:${token()}`, now, now);
    await ctx.db.collection('checkJobs').insertOne(job, { session });
    await audit(ctx, session, { action: 'check.requested', actorId, projectId: service.projectId, resourceId: service._id, metadata: { jobId: job._id.toHexString() } });
    return job;
  });
}

export function calculateStatus(service: Document, outcome: CheckOutcome): { calculatedStatus: ServiceStatus; failureStreak: number; successStreak: number } {
  let calculatedStatus: ServiceStatus = service.calculatedStatus ?? 'unknown';
  const failureStreak = outcome.success ? 0 : (service.failureStreak ?? 0) + 1;
  const successStreak = outcome.success ? (service.successStreak ?? 0) + 1 : 0;
  if (!outcome.success) {
    if (failureStreak >= (service.failureThreshold ?? 3)) calculatedStatus = 'outage';
    else if (calculatedStatus !== 'outage') calculatedStatus = 'degraded';
  }
  if (outcome.success && successStreak >= (service.recoveryThreshold ?? 2)) {
    calculatedStatus = outcome.latencyMs >= service.slowThresholdMs ? 'degraded' : 'operational';
  }
  return { calculatedStatus, failureStreak, successStreak };
}

async function history(ctx: AppContext, session: ClientSession, service: Document, from: ServiceStatus, to: ServiceStatus, reason: string, jobId?: ObjectId) {
  if (from === to) return;
  await ctx.db.collection('statusHistory').insertOne({ serviceId: service._id, projectId: service.projectId, from, to, reason, createdAt: ctx.now(), ...(jobId ? { jobId } : {}) }, { session });
}

async function incidentUpdate(ctx: AppContext, session: ClientSession, service: Document, incident: Document, message: string) {
  const update = { _id: new ObjectId(), incidentId: incident._id, projectId: service.projectId, serviceId: service._id,
    message, state: incident.state, publicVisible: Boolean(incident.publicVisible), createdAt: ctx.now(), createdBy: null };
  await ctx.db.collection('incidentUpdates').insertOne(update, { session });
  await notifyPublicIncidentUpdate(ctx, session, update);
}

async function updateAutomaticIncident(ctx: AppContext, session: ClientSession, service: Document, next: ServiceStatus, recoveryReached: boolean) {
  const now = ctx.now();
  if (next === 'outage') {
    let incident = await ctx.db.collection('incidents').findOne({ serviceId: service._id, active: true }, { session });
    if (!incident) {
      incident = { _id: new ObjectId(), projectId: service.projectId, serviceId: service._id, title: `${service.name} is unavailable`,
        state: 'investigating', active: true, publicVisible: Boolean(service.publicVisible), createdAt: now, updatedAt: now,
        createdBy: null, source: 'monitor', version: 1, lastMonitorStatus: 'outage' };
      await ctx.db.collection('incidents').insertOne(incident, { session });
      await incidentUpdate(ctx, session, service, incident, 'Automatic checks reached the configured failure threshold.');
      await audit(ctx, session, { action: 'incident.auto_created', projectId: service.projectId, resourceId: incident._id });
    } else if (incident.lastMonitorStatus !== 'outage') {
      await ctx.db.collection('incidents').updateOne({ _id: incident._id }, { $set: { lastMonitorStatus: 'outage', updatedAt: now },
        $unset: { recoveryDetectedAt: '' }, $inc: { version: 1 } }, { session });
    }
    await ctx.db.collection('alerts').updateOne({ dedupeKey: `outage:${incident._id}` }, { $setOnInsert: {
      _id: new ObjectId(), projectId: service.projectId, serviceId: service._id, incidentId: incident._id,
      dedupeKey: `outage:${incident._id}`, kind: 'outage', deliveryState: 'pending', attempts: 0, createdAt: now,
    } }, { upsert: true, session });
  } else if (recoveryReached && (next === 'operational' || next === 'degraded')) {
    const incident = await ctx.db.collection('incidents').findOneAndUpdate({ serviceId: service._id, active: true, lastMonitorStatus: 'outage' },
      { $set: { lastMonitorStatus: 'recovered', recoveryDetectedAt: now, updatedAt: now }, $inc: { version: 1 } }, { session, returnDocument: 'after' });
    if (incident) {
      await incidentUpdate(ctx, session, service, incident, 'Automatic checks reached the configured recovery threshold. A responder must confirm recovery and advance the incident lifecycle.');
      await audit(ctx, session, { action: 'incident.recovery_detected', projectId: service.projectId, resourceId: incident._id });
    }
  }
}

async function recordWorkerFailure(ctx: AppContext, session: ClientSession, job: Document, reason: string) {
  await audit(ctx, session, { action: 'check.worker_failed', projectId: job.projectId, resourceId: job.serviceId,
    metadata: { jobId: job._id.toHexString(), attempts: job.attempts, reason } });
  await ctx.db.collection('operationalEvents').insertOne({ type: 'worker_failure', projectId: job.projectId,
    serviceId: job.serviceId, jobId: job._id, attempts: job.attempts, reason, createdAt: ctx.now() }, { session });
}

async function reapExhaustedJobs(ctx: AppContext): Promise<void> {
  const now = ctx.now();
  const expired = await ctx.db.collection('checkJobs').find({ attempts: { $gte: MAX_ATTEMPTS }, $or: [
    { state: 'leased', leaseUntil: { $lte: now } }, { state: 'ready', availableAt: { $lte: now } },
  ] }).limit(100).toArray();
  for (const job of expired) await transaction(ctx, async session => {
    const result = await ctx.db.collection('checkJobs').updateOne({ _id: job._id, state: job.state, attempts: job.attempts,
      ...(job.state === 'leased' ? { leaseToken: job.leaseToken, leaseUntil: { $lte: now } } : {}) },
    { $set: { state: 'failed', lastError: 'attempts_exhausted', finishedAt: now }, $unset: { leaseToken: '', leaseUntil: '' } }, { session });
    if (result.modifiedCount) await recordWorkerFailure(ctx, session, job, 'attempts_exhausted');
  });
}

function validOutcome(value: CheckOutcome): boolean {
  return typeof value?.success === 'boolean' && Number.isFinite(value.latencyMs) && value.latencyMs >= 0
    && (value.httpStatus === null || (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599))
    && (value.failureReason === null || (typeof value.failureReason === 'string' && value.failureReason.length <= 100));
}

function ineligibleReason(job: Document, service: Document | null, project: Document | null): string | null {
  if (!service || service.archivedAt || !project) return 'archived';
  if (!service.enabled) return 'disabled';
  if (service.configVersion !== job.configVersion) return 'configuration_changed';
  return null;
}

async function finishJob(ctx: AppContext, job: Document, outcome: CheckOutcome): Promise<void> {
  await transaction(ctx, async session => {
    const now = ctx.now();
    const claimed = await ctx.db.collection('checkJobs').updateOne({ _id: job._id, state: 'leased', leaseToken: job.leaseToken, leaseUntil: { $gt: now } },
      { $set: { state: 'done', finishedAt: now }, $unset: { leaseToken: '', leaseUntil: '' } }, { session });
    if (!claimed.modifiedCount) return; // An expired/fenced worker cannot commit a result.
    const service = await ctx.db.collection('services').findOne({ _id: job.serviceId, projectId: job.projectId }, { session });
    const project = await ctx.db.collection('projects').findOne({ _id: job.projectId, archivedAt: { $exists: false } }, { session });
    let skipReason = ineligibleReason(job, service, project);
    if (!skipReason && service?.lastProcessedDueAt) {
      const previous = new Date(service.lastProcessedDueAt).getTime();
      const due = new Date(job.dueAt).getTime();
      if (due < previous || (due === previous && service.lastProcessedJobId && String(job._id) <= String(service.lastProcessedJobId))) skipReason = 'out_of_order';
    }
    await ctx.db.collection('checkResults').insertOne({ _id: new ObjectId(), jobId: job._id, serviceId: job.serviceId,
      projectId: job.projectId, checkedAt: now, dueAt: job.dueAt, configVersion: job.configVersion,
      ...outcome, applied: !skipReason, skipReason }, { session });
    if (skipReason || !service) return;
    const from: ServiceStatus = service.observedStatus ?? effectiveStatus(service, now);
    const status = calculateStatus(service, outcome);
    const expiredOverride = service.override && new Date(service.override.expiresAt) <= now;
    const nextService = { ...service, ...status, lastCheckedAt: now, ...(expiredOverride ? { override: undefined } : {}) };
    const observedStatus = effectiveStatus(nextService, now);
    await ctx.db.collection('services').updateOne({ _id: service._id }, {
      $set: { ...status, observedStatus, lastCheckedAt: now, lastProcessedDueAt: job.dueAt, lastProcessedJobId: job._id, updatedAt: now },
      ...(expiredOverride ? { $unset: { override: '' } } : {}),
    }, { session });
    await history(ctx, session, service, from, observedStatus, expiredOverride ? 'override_expired' : 'check_result', job._id);
    if (expiredOverride) await audit(ctx, session, { action: 'service.override_expired', projectId: service.projectId, resourceId: service._id, metadata: { restoredStatus: observedStatus } });
    await updateAutomaticIncident(ctx, session, service, status.calculatedStatus,
      outcome.success && status.successStreak >= (service.recoveryThreshold ?? 2));
  });
}

/** Returns true when a job was claimed, even when its worker attempt needs retrying. */
export async function runNextCheck(ctx: AppContext, checker: Checker = checkEndpoint): Promise<boolean> {
  await reapExhaustedJobs(ctx);
  const now = ctx.now();
  const job = await transaction<Document | null>(ctx, async session => {
    const leaseToken = token();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const previous = await ctx.db.collection('checkJobs').findOneAndUpdate({ attempts: { $lt: MAX_ATTEMPTS }, $or: [
      { state: 'ready', availableAt: { $lte: now } }, { state: 'leased', leaseUntil: { $lte: now } },
    ] }, { $set: { state: 'leased', leaseToken, leaseUntil }, $inc: { attempts: 1 } },
    { sort: { dueAt: 1, _id: 1 }, returnDocument: 'before', session });
    if (!previous) return null;
    if (previous.state === 'leased') await recordWorkerFailure(ctx, session, previous, 'lease_expired');
    // Queued work can outlive a configuration change, disable or archive. Recheck
    // eligibility before network access; cancellation is not a failed observation.
    const service = await ctx.db.collection('services').findOne({ _id: previous.serviceId, projectId: previous.projectId }, { session });
    const project = await ctx.db.collection('projects').findOne({ _id: previous.projectId, archivedAt: { $exists: false } }, { session });
    const cancellationReason = ineligibleReason(previous, service, project);
    if (cancellationReason) {
      await ctx.db.collection('checkJobs').updateOne({ _id: previous._id, state: 'leased', leaseToken }, {
        $set: { state: 'cancelled', cancellationReason, finishedAt: ctx.now() }, $unset: { leaseToken: '', leaseUntil: '' },
      }, { session });
      await audit(ctx, session, { action: 'check.cancelled', projectId: previous.projectId, resourceId: previous.serviceId,
        metadata: { jobId: previous._id.toHexString(), reason: cancellationReason } });
      return { ...previous, state: 'cancelled' };
    }
    return { ...previous, state: 'leased', attempts: previous.attempts + 1, leaseToken, leaseUntil };
  });
  if (!job) return false;
  if (job.state === 'cancelled') return true;
  let outcome: CheckOutcome;
  try {
    outcome = await checker(job.config as CheckConfig);
    if (!validOutcome(outcome)) throw new Error('Checker returned an invalid outcome');
  } catch {
    await transaction(ctx, async session => {
      const failed = job.attempts >= MAX_ATTEMPTS;
      const current = ctx.now();
      const result = await ctx.db.collection('checkJobs').updateOne({ _id: job._id, state: 'leased', leaseToken: job.leaseToken, leaseUntil: { $gt: current } },
        { $set: { state: failed ? 'failed' : 'ready', lastError: 'internal_worker_failure',
          availableAt: new Date(current.getTime() + 1000 * 2 ** (job.attempts - 1)), ...(failed ? { finishedAt: current } : {}) },
        $unset: { leaseToken: '', leaseUntil: '' } }, { session });
      if (result.modifiedCount) await recordWorkerFailure(ctx, session, job, 'internal_worker_failure');
    });
    return true;
  }
  // Persistence errors propagate to the worker supervisor. Its lease makes the unfinished job reclaimable.
  await finishJob(ctx, job, outcome);
  return true;
}

/** Preserve the underlying calculation while recording expiry/staleness as visible state changes. */
export async function expireOverridesAndRecordStale(ctx: AppContext): Promise<void> {
  const candidates = ctx.db.collection('services').find({ archivedAt: { $exists: false }, $or: [
    { 'override.expiresAt': { $lte: ctx.now() } }, { observedStatus: { $ne: 'unknown' } },
  ] });
  for await (const candidate of candidates) await transaction(ctx, async session => {
    const service = await ctx.db.collection('services').findOne({ _id: candidate._id, archivedAt: { $exists: false } }, { session });
    if (!service) return;
    const now = ctx.now();
    const expiredOverride = service.override && new Date(service.override.expiresAt) <= now;
    const to = effectiveStatus(service, now);
    const from: ServiceStatus = service.observedStatus ?? service.calculatedStatus ?? 'unknown';
    if (!expiredOverride && to === from) return;
    await ctx.db.collection('services').updateOne({ _id: service._id }, { $set: { observedStatus: to }, ...(expiredOverride ? { $unset: { override: '' } } : {}) }, { session });
    await history(ctx, session, service, from, to, expiredOverride ? 'override_expired' : service.enabled ? 'stale' : 'disabled');
    if (expiredOverride) await audit(ctx, session, { action: 'service.override_expired', projectId: service.projectId, resourceId: service._id, metadata: { restoredStatus: to } });
  });
}

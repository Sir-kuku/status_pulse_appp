import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ObjectId, type Document } from 'mongodb';
import { createTestContext } from './helpers.js';
import { effectiveStatus, type AppContext } from '../src/core.js';
import { calculateStatus, enqueueManualCheck, expireOverridesAndRecordStale, runNextCheck, scheduleDue } from '../src/monitoring.js';
import type { CheckOutcome } from '../src/endpoint-checker.js';

const healthy: CheckOutcome = { success: true, httpStatus: 200, latencyMs: 50, failureReason: null };
const failed: CheckOutcome = { success: false, httpStatus: 503, latencyMs: 50, failureReason: 'unexpected_http_status' };

test('threshold calculation retains an outage through partial recovery and classifies slow successful checks', () => {
  let service: Document = { calculatedStatus: 'unknown', failureStreak: 0, successStreak: 0, failureThreshold: 3, recoveryThreshold: 2, slowThresholdMs: 1000 };
  service = { ...service, ...calculateStatus(service, healthy) };
  assert.equal(service.calculatedStatus, 'unknown');
  service = { ...service, ...calculateStatus(service, healthy) };
  assert.equal(service.calculatedStatus, 'operational');
  for (let n = 0; n < 3; n++) service = { ...service, ...calculateStatus(service, failed) };
  assert.equal(service.calculatedStatus, 'outage');
  service = { ...service, ...calculateStatus(service, healthy) };
  assert.equal(service.calculatedStatus, 'outage');
  service = { ...service, ...calculateStatus(service, { ...healthy, latencyMs: 1500 }) };
  assert.equal(service.calculatedStatus, 'degraded');
  assert.equal(service.failureStreak, 0);
});

describe('transactional monitoring', () => {
  let ctx: AppContext;
  let close: () => Promise<void>;
  let now: Date;
  let service: Document;
  const actorId = new ObjectId();
  before(async () => { ({ ctx, close } = await createTestContext()); });
  after(async () => { await close?.(); });
  beforeEach(async () => {
    for (const name of ['projects', 'services', 'checkJobs', 'checkResults', 'statusHistory', 'incidents', 'incidentUpdates', 'alerts', 'auditEvents', 'operationalEvents', 'subscriptions', 'notifications']) {
      await ctx.db.collection(name).deleteMany({});
    }
    now = new Date('2026-10-16T10:00:00.000Z');
    ctx.now = () => new Date(now);
    const projectId = new ObjectId();
    await ctx.db.collection('projects').insertOne({ _id: projectId, slug: 'monitoring-project', publicEnabled: true, ownerId: actorId });
    service = { _id: new ObjectId(), projectId, name: 'API', url: 'https://health.example.com/', method: 'GET',
      intervalSeconds: 60, timeoutMs: 5000, expectedStatusMin: 200, expectedStatusMax: 299, slowThresholdMs: 1000,
      failureThreshold: 3, recoveryThreshold: 2, enabled: true, publicVisible: true, configVersion: 1,
      nextCheckAt: now, calculatedStatus: 'unknown', observedStatus: 'unknown', failureStreak: 0, successStreak: 0,
      createdAt: now, updatedAt: now };
    await ctx.db.collection('services').insertOne(service);
  });
  const advance = (ms = 60_000) => { now = new Date(now.getTime() + ms); };
  async function run(outcome: CheckOutcome) {
    advance();
    await enqueueManualCheck(ctx, service, actorId);
    assert.equal(await runNextCheck(ctx, async () => outcome), true);
    return (await ctx.db.collection('services').findOne({ _id: service._id }))!;
  }

  test('concurrent schedulers create one immutable job and atomically advance the next due slot', async () => {
    const counts = await Promise.all([scheduleDue(ctx), scheduleDue(ctx), scheduleDue(ctx)]);
    assert.equal(counts.reduce((a, b) => a + b, 0), 1);
    assert.equal(await ctx.db.collection('checkJobs').countDocuments(), 1);
    const job = await ctx.db.collection('checkJobs').findOne({});
    assert.equal(job?.config.url, service.url);
    assert.equal(job?.configVersion, 1);
    assert.equal((await ctx.db.collection('services').findOne({ _id: service._id }))?.nextCheckAt.toISOString(), '2026-10-16T10:01:00.000Z');
    advance(10 * 60_000);
    assert.equal(await scheduleDue(ctx), 1, 'missed slots are coalesced instead of flooding the queue');
    assert.equal(await scheduleDue(ctx), 0);
    assert.equal(await ctx.db.collection('checkJobs').countDocuments(), 2);
  });

  test('parallel workers accept a job once and preserve one result', async () => {
    await scheduleDue(ctx);
    let checks = 0;
    const checker = async () => { checks++; return healthy; };
    const results = await Promise.all([runNextCheck(ctx, checker), runNextCheck(ctx, checker), runNextCheck(ctx, checker)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(checks, 1);
    assert.equal(await ctx.db.collection('checkResults').countDocuments(), 1);
  });

  test('threshold outage creates one incident and alert; recovery records evidence without resolving the incident', async () => {
    await ctx.db.collection('subscriptions').insertOne({ projectId: service.projectId, email: 'viewer@example.com',
      serviceIds: [service._id], verifiedAt: now });
    assert.equal((await run(healthy)).calculatedStatus, 'unknown');
    assert.equal((await run(healthy)).calculatedStatus, 'operational');
    assert.equal((await run(failed)).calculatedStatus, 'degraded');
    assert.equal((await run(failed)).calculatedStatus, 'degraded');
    assert.equal((await run(failed)).calculatedStatus, 'outage');
    await run(failed);
    assert.equal(await ctx.db.collection('incidents').countDocuments({ active: true }), 1);
    assert.equal(await ctx.db.collection('alerts').countDocuments(), 1);
    assert.equal((await run(healthy)).calculatedStatus, 'outage');
    assert.equal(await ctx.db.collection('incidents').countDocuments({ active: true }), 1);
    assert.equal((await run(healthy)).calculatedStatus, 'operational');
    assert.equal(await ctx.db.collection('incidents').countDocuments({ active: true }), 1);
    assert.equal((await ctx.db.collection('incidents').findOne({}))?.state, 'investigating');
    assert.equal((await ctx.db.collection('incidents').findOne({}))?.lastMonitorStatus, 'recovered');
    assert.equal(await ctx.db.collection('incidentUpdates').countDocuments(), 2);
    assert.equal(await ctx.db.collection('notifications').countDocuments({ deliveryState: 'delivered' }), 2);
    assert.deepEqual((await ctx.db.collection('statusHistory').find({}).sort({ createdAt: 1 }).toArray()).map(row => row.to), ['operational', 'degraded', 'outage', 'operational']);
  });

  test('a monitor incident survives a configuration reset and records recovery after fresh healthy checks', async () => {
    for (let n = 0; n < 3; n++) await run(failed);
    await ctx.db.collection('services').updateOne({ _id: service._id }, { $set: {
      calculatedStatus: 'unknown', observedStatus: 'unknown', failureStreak: 0, successStreak: 0,
    }, $inc: { configVersion: 1 }, $unset: { lastCheckedAt: '', lastProcessedDueAt: '' } });
    await run(healthy);
    assert.equal(await ctx.db.collection('incidents').countDocuments({ active: true }), 1);
    await run(healthy);
    assert.equal(await ctx.db.collection('incidents').countDocuments({ active: true }), 1);
    assert.equal((await ctx.db.collection('incidents').findOne({}))?.lastMonitorStatus, 'recovered');
  });

  test('existing manual incident receives the deduped outage alert and is not automatically resolved', async () => {
    const incidentId = new ObjectId();
    await ctx.db.collection('incidents').insertOne({ _id: incidentId, projectId: service.projectId, serviceId: service._id,
      state: 'investigating', active: true, source: 'manual', publicVisible: false, version: 1 });
    for (let n = 0; n < 3; n++) await run(failed);
    await run(healthy);
    await run(healthy);
    assert.equal(await ctx.db.collection('incidents').countDocuments(), 1);
    assert.equal((await ctx.db.collection('incidents').findOne({ _id: incidentId }))?.active, true);
    assert.equal((await ctx.db.collection('alerts').findOne({}))?.dedupeKey, `outage:${incidentId}`);
  });

  test('a configuration change or disable during execution preserves an unapplied result', async () => {
    await enqueueManualCheck(ctx, service, actorId);
    await runNextCheck(ctx, async () => {
      await ctx.db.collection('services').updateOne({ _id: service._id }, { $inc: { configVersion: 1 }, $set: { url: 'https://changed.example.com/' } });
      return failed;
    });
    assert.equal((await ctx.db.collection('checkResults').findOne({}))?.skipReason, 'configuration_changed');
    assert.equal((await ctx.db.collection('services').findOne({ _id: service._id }))?.failureStreak, 0);
    advance();
    await enqueueManualCheck(ctx, service, actorId);
    await runNextCheck(ctx, async () => {
      await ctx.db.collection('services').updateOne({ _id: service._id }, { $set: { enabled: false } });
      return failed;
    });
    assert.equal(await ctx.db.collection('checkResults').countDocuments({ applied: false }), 2);
    assert.equal(await ctx.db.collection('checkResults').countDocuments({ skipReason: 'disabled' }), 1);
    await assert.rejects(enqueueManualCheck(ctx, service, actorId), /Enable the service/);
  });

  test('a late result cannot overwrite a newer scheduled result', async () => {
    await enqueueManualCheck(ctx, service, actorId);
    let started!: () => void;
    let release!: (outcome: CheckOutcome) => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const first = runNextCheck(ctx, async () => { started(); return new Promise(resolve => { release = resolve; }); });
    await startedPromise;
    advance(1000);
    await enqueueManualCheck(ctx, service, actorId);
    await runNextCheck(ctx, async () => healthy);
    release(failed);
    await first;
    assert.equal(await ctx.db.collection('checkResults').countDocuments(), 2);
    assert.equal(await ctx.db.collection('checkResults').countDocuments({ skipReason: 'out_of_order' }), 1);
    assert.equal((await ctx.db.collection('services').findOne({ _id: service._id }))?.failureStreak, 0);
  });

  test('expired lease fencing rejects the old completion after another worker reclaims the job', async () => {
    await scheduleDue(ctx);
    let started!: () => void;
    let release!: (outcome: CheckOutcome) => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const first = runNextCheck(ctx, async () => { started(); return new Promise(resolve => { release = resolve; }); });
    await startedPromise;
    advance(121_000);
    assert.equal(await runNextCheck(ctx, async () => healthy), true);
    release(failed);
    await first;
    const result = await ctx.db.collection('checkResults').findOne({});
    assert.equal(result?.success, true);
    assert.equal(await ctx.db.collection('checkResults').countDocuments(), 1);
    assert.equal((await ctx.db.collection('checkJobs').findOne({}))?.attempts, 2);
    assert.equal(await ctx.db.collection('operationalEvents').countDocuments({ reason: 'lease_expired' }), 1);
  });

  test('HTTP failures are final records; thrown worker failures back off, retry, stop and audit', async () => {
    const httpJob = await enqueueManualCheck(ctx, service, actorId);
    await runNextCheck(ctx, async () => failed);
    assert.equal((await ctx.db.collection('checkJobs').findOne({ _id: httpJob._id }))?.state, 'done');
    advance();
    const internalJob = await enqueueManualCheck(ctx, service, actorId);
    let calls = 0;
    const broken = async (): Promise<CheckOutcome> => { calls++; throw new Error('sensitive stack / credentials must not be stored'); };
    assert.equal(await runNextCheck(ctx, broken), true);
    assert.equal(await runNextCheck(ctx, broken), false);
    advance(1000);
    await runNextCheck(ctx, broken);
    advance(2000);
    await runNextCheck(ctx, broken);
    advance(10_000);
    assert.equal(await runNextCheck(ctx, broken), false);
    assert.equal(calls, 3);
    assert.equal((await ctx.db.collection('checkJobs').findOne({ _id: internalJob._id }))?.state, 'failed');
    assert.equal(await ctx.db.collection('checkResults').countDocuments({ jobId: internalJob._id }), 0);
    assert.equal(await ctx.db.collection('auditEvents').countDocuments({ action: 'check.worker_failed' }), 3);
    assert.equal(await ctx.db.collection('operationalEvents').countDocuments(), 3);
  });

  test('the final crashed lease is reaped without another execution attempt', async () => {
    const job = await enqueueManualCheck(ctx, service, actorId);
    await ctx.db.collection('checkJobs').updateOne({ _id: job._id }, { $set: { state: 'leased', attempts: 3, leaseToken: 'old', leaseUntil: now } });
    assert.equal(await runNextCheck(ctx, async () => { throw new Error('must not execute'); }), false);
    assert.equal((await ctx.db.collection('checkJobs').findOne({ _id: job._id }))?.state, 'failed');
    assert.equal(await ctx.db.collection('operationalEvents').countDocuments({ reason: 'attempts_exhausted' }), 1);
  });

  test('overrides preserve real failure counting; expiry and stale visibility are audited without erasing calculation', async () => {
    const expiry = new Date(now.getTime() + 240_000);
    await ctx.db.collection('services').updateOne({ _id: service._id }, { $set: {
      override: { status: 'operational', reason: 'Operator investigation', expiresAt: expiry, actorId }, observedStatus: 'operational',
    } });
    for (let n = 0; n < 3; n++) await run(failed);
    let current = (await ctx.db.collection('services').findOne({ _id: service._id }))!;
    assert.equal(current.calculatedStatus, 'outage');
    assert.equal(effectiveStatus(current, now), 'operational');
    assert.equal(current.failureStreak, 3);
    assert.equal(await ctx.db.collection('incidents').countDocuments({ active: true }), 1);
    advance();
    await expireOverridesAndRecordStale(ctx);
    current = (await ctx.db.collection('services').findOne({ _id: service._id }))!;
    assert.equal(current.override, undefined);
    assert.equal(current.observedStatus, 'outage');
    assert.equal(await ctx.db.collection('auditEvents').countDocuments({ action: 'service.override_expired' }), 1);
    await expireOverridesAndRecordStale(ctx);
    assert.equal(await ctx.db.collection('auditEvents').countDocuments({ action: 'service.override_expired' }), 1);
    advance(181_000);
    assert.equal(effectiveStatus(current, now), 'unknown', 'reads report stale status even before housekeeping');
    await expireOverridesAndRecordStale(ctx);
    current = (await ctx.db.collection('services').findOne({ _id: service._id }))!;
    assert.equal(current.observedStatus, 'unknown');
    assert.equal(current.calculatedStatus, 'outage');
    assert.equal(await ctx.db.collection('statusHistory').countDocuments({ reason: 'stale', to: 'unknown' }), 1);
    await ctx.db.collection('services').updateOne({ _id: service._id }, { $set: { enabled: false,
      override: { status: 'operational', expiresAt: new Date(now.getTime() + 60_000) } } });
    assert.equal(effectiveStatus((await ctx.db.collection('services').findOne({ _id: service._id }))!, now), 'unknown');
  });
});

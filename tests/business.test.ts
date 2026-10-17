import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { createTestContext } from './helpers.js';
import { type AppContext, HttpError, hashToken, token, transaction } from '../src/core.js';
import { incidentRouter } from '../src/incident-routes.js';
import { publicRouter } from '../src/public-routes.js';
import { deliverPendingAlerts, notifyPublicIncidentUpdate } from '../src/delivery.js';

let ctx: AppContext;
let close: () => Promise<void>;
let server: Server;
let base: string;
before(async () => {
  ({ ctx, close } = await createTestContext());
  const app = express();
  app.use(express.json());
  app.use('/api/public', publicRouter(ctx));
  app.use('/api/projects', incidentRouter(ctx));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) { res.status(error.status).json({ code: error.code }); return; }
    if (error instanceof z.ZodError) { res.status(422).json({ code: 'VALIDATION_ERROR' }); return; }
    if ((error as { code?: number }).code === 11000) { res.status(409).json({ code: 'CONFLICT' }); return; }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: String(error) });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); if (close) await close(); });

async function request(method: string, path: string, body?: unknown, bearer?: string) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
async function fixture() {
  const projectId = new ObjectId();
  const slug = `project-${projectId}`;
  const credentials: Record<string, string> = {};
  const userIds: Record<string, ObjectId> = {};
  for (const role of ['owner', 'responder', 'viewer', 'outsider']) {
    const userId = new ObjectId();
    const bearer = token();
    credentials[role] = bearer;
    userIds[role] = userId;
    await ctx.db.collection('users').insertOne({ _id: userId, email: `${role}-${userId}@example.test`, name: role, platformRole: 'user' });
    await ctx.db.collection('sessions').insertOne({ userId, tokenHash: hashToken(bearer), expiresAt: new Date(ctx.now().getTime() + 3600000) });
    if (role !== 'outsider') await ctx.db.collection('memberships').insertOne({ projectId, userId, role });
  }
  await ctx.db.collection('projects').insertOne({ _id: projectId, slug, name: 'Public API', ownerId: userIds.owner, publicEnabled: true, plan: 'free', createdAt: ctx.now() });
  const services = [];
  for (const publicVisible of [true, false]) {
    const service = { _id: new ObjectId(), projectId, name: publicVisible ? 'Public service' : 'Private payroll', publicVisible,
      url: 'https://private-secret-endpoint.example/internal', method: 'GET', enabled: true, calculatedStatus: 'operational', intervalSeconds: 60, lastCheckedAt: ctx.now(), createdAt: ctx.now() };
    await ctx.db.collection('services').insertOne(service);
    services.push(service);
  }
  const service = services[0]!;
  const privateService = services[1]!;
  return { projectId, slug, service, privateService, credentials, userIds, path: `/api/projects/${projectId}`, publicPath: `/api/public/projects/${slug}` };
}

test('incident permissions, single active incident, ordered lifecycle and concurrent version protection', async () => {
  const f = await fixture();
  const path = `${f.path}/services/${f.service._id}/incidents`;
  const body = { title: 'API unavailable', message: 'Investigating the outage.', publicVisible: true };
  assert.equal((await request('POST', path, body, f.credentials.viewer)).status, 403);
  assert.equal((await request('POST', path, body, f.credentials.outsider)).status, 404);
  const created = await request('POST', path, body, f.credentials.responder);
  assert.equal(created.status, 201);
  assert.equal(created.body.incident.version, 1);
  assert.equal((await request('POST', path, body, f.credentials.owner)).status, 409);
  const updatePath = `${f.path}/incidents/${created.body.incident._id}/updates`;
  assert.equal((await request('POST', updatePath, { version: 1, state: 'resolved', message: 'Skip lifecycle' }, f.credentials.owner)).status, 409);
  const outcomes = await Promise.all([
    request('POST', updatePath, { version: 1, state: 'identified', message: 'Root cause found' }, f.credentials.owner),
    request('POST', updatePath, { version: 1, state: 'identified', message: 'Concurrent update' }, f.credentials.responder),
  ]);
  assert.deepEqual(outcomes.map(result => result.status).sort(), [201, 409]);
  assert.equal((await request('POST', updatePath, { version: 2, state: 'monitoring', message: 'Fix deployed' }, f.credentials.owner)).status, 201);
  const resolved = await request('POST', updatePath, { version: 3, state: 'resolved', message: 'Recovered' }, f.credentials.owner);
  assert.equal(resolved.status, 201);
  assert.equal(resolved.body.incident.active, false);
  assert.equal((await request('POST', path, body, f.credentials.owner)).status, 201);
  assert.equal(await ctx.db.collection('incidents').countDocuments({ serviceId: f.service._id, active: true }), 1);
});

test('public pages expose only visible services and allowlisted incident, history and update fields', async () => {
  const f = await fixture();
  const visible = await request('POST', `${f.path}/services/${f.service._id}/incidents`, { title: 'Public incident', message: 'Public notice', publicVisible: true }, f.credentials.owner);
  const hidden = await request('POST', `${f.path}/services/${f.privateService._id}/incidents`, { title: 'Secret payroll problem', message: 'Secret internal notice', publicVisible: true }, f.credentials.owner);
  await request('POST', `${f.path}/incidents/${visible.body.incident._id}/updates`, { version: 1, message: 'Secret operator notes', publicVisible: false }, f.credentials.owner);
  await ctx.db.collection('statusHistory').insertOne({ projectId: f.projectId, serviceId: f.service._id, from: 'operational', to: 'outage', createdAt: ctx.now(), reason: 'Secret override reason', actorId: f.userIds.owner });
  const page = await request('GET', f.publicPath);
  assert.equal(page.status, 200);
  assert.equal(page.body.services.length, 1);
  assert.equal(page.body.services[0]._id, String(f.service._id));
  assert.doesNotMatch(JSON.stringify(page.body), /private-secret|payroll|ownerId|configVersion|email/);
  const incidents = await request('GET', `${f.publicPath}/incidents`);
  assert.equal(incidents.body.items.length, 1);
  assert.equal((await request('GET', `${f.publicPath}/incidents/${hidden.body.incident._id}`)).status, 404);
  const details = await request('GET', `${f.publicPath}/incidents/${visible.body.incident._id}`);
  assert.equal(details.body.updates.length, 1);
  assert.doesNotMatch(JSON.stringify(details.body), /Secret|createdBy|projectId/);
  const history = await request('GET', `${f.publicPath}/services/${f.service._id}/history`);
  assert.equal(history.body.items.length, 1);
  assert.doesNotMatch(JSON.stringify(history.body), /Secret|actorId|reason/);
  assert.equal((await request('GET', `${f.publicPath}/services/${f.privateService._id}/history`)).status, 404);
  await ctx.db.collection('projects').updateOne({ _id: f.projectId }, { $set: { publicEnabled: false } });
  assert.equal((await request('GET', f.publicPath)).status, 404);
});

test('subscriptions normalize email, hash tokens, reject private selections, recheck visibility and notify verified selections once', async () => {
  const f = await fixture();
  assert.equal((await request('POST', `${f.publicPath}/subscriptions`, { email: 'reader@example.test', serviceIds: [String(f.privateService._id)] })).status, 400);
  const signup = await request('POST', `${f.publicPath}/subscriptions`, { email: ' Reader@Example.test ', serviceIds: [String(f.service._id)] });
  assert.equal(signup.status, 202);
  const verificationToken = signup.body.simulatedEmail.verificationToken as string;
  const subscription = await ctx.db.collection('subscriptions').findOne({ projectId: f.projectId });
  assert.ok(subscription);
  assert.equal(subscription.email, 'reader@example.test');
  assert.equal(subscription.verificationTokenHash, hashToken(verificationToken));
  assert.doesNotMatch(JSON.stringify(subscription), new RegExp(verificationToken));
  const duplicate = await request('POST', `${f.publicPath}/subscriptions`, { email: 'reader@example.test', serviceIds: [String(f.service._id)] });
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.simulatedEmail, undefined);
  const concurrentSignups = await Promise.all([
    request('POST', `${f.publicPath}/subscriptions`, { email: 'concurrent@example.test', serviceIds: [String(f.service._id)] }),
    request('POST', `${f.publicPath}/subscriptions`, { email: 'CONCURRENT@example.test', serviceIds: [String(f.service._id)] }),
  ]);
  assert.deepEqual(concurrentSignups.map(result => result.status), [202, 202]);
  assert.equal(concurrentSignups.filter(result => result.body.simulatedEmail).length, 1);
  await ctx.db.collection('services').updateOne({ _id: f.service._id }, { $set: { publicVisible: false } });
  assert.equal((await request('POST', '/api/public/subscriptions/verify', { token: verificationToken })).status, 409);
  await ctx.db.collection('services').updateOne({ _id: f.service._id }, { $set: { publicVisible: true } });
  assert.equal((await request('POST', '/api/public/subscriptions/verify', { token: verificationToken })).status, 200);
  assert.equal((await request('POST', '/api/public/subscriptions/verify', { token: verificationToken })).status, 400);
  await request('POST', `${f.publicPath}/subscriptions`, { email: 'unverified@example.test', serviceIds: [String(f.service._id)] });
  const incident = await request('POST', `${f.path}/services/${f.service._id}/incidents`, { title: 'Public degradation', message: 'We are investigating', publicVisible: true }, f.credentials.owner);
  const update = await ctx.db.collection('incidentUpdates').findOne({ _id: new ObjectId(incident.body.update._id) });
  assert.ok(update);
  await transaction(ctx, session => notifyPublicIncidentUpdate(ctx, session, update));
  const notifications = await ctx.db.collection('notifications').find({ projectId: f.projectId }).toArray();
  assert.equal(notifications.length, 1);
  assert.equal(String(notifications[0]!.subscriptionId), String(subscription._id));
  assert.equal(notifications[0]!.simulation, true);
  assert.equal(notifications[0]!.deliveryState, 'delivered');
  await request('POST', `${f.path}/incidents/${incident.body.incident._id}/updates`, { version: 1, message: 'Internal secret', publicVisible: false }, f.credentials.owner);
  assert.equal(await ctx.db.collection('notifications').countDocuments({ projectId: f.projectId }), 1);
});

test('production simulation keeps verification tokens in owner-only inbox and expiry rejects verification', async () => {
  const f = await fixture();
  const priorEnv = ctx.config.env;
  ctx.config.env = 'production';
  try {
    const signup = await request('POST', `${f.publicPath}/subscriptions`, { email: 'prod@example.test', serviceIds: [String(f.service._id)] });
    assert.equal(signup.status, 202);
    assert.equal(signup.body.simulatedEmail, undefined);
    assert.equal((await request('GET', `${f.path}/simulated-mail`)).status, 401);
    assert.equal((await request('GET', `${f.path}/simulated-mail`, undefined, f.credentials.viewer)).status, 403);
    const inbox = await request('GET', `${f.path}/simulated-mail`, undefined, f.credentials.owner);
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.items.length, 1);
    const verificationToken = inbox.body.items[0].token;
    await ctx.db.collection('subscriptions').updateOne({ projectId: f.projectId }, { $set: { verificationExpiresAt: new Date(0) } });
    assert.equal((await request('POST', '/api/public/subscriptions/verify', { token: verificationToken })).status, 400);
    const renewed = await request('POST', `${f.publicPath}/subscriptions`, { email: 'prod@example.test', serviceIds: [String(f.service._id)] });
    assert.equal(renewed.status, 202);
    assert.equal(renewed.body.simulatedEmail, undefined);
    const newInbox = await request('GET', `${f.path}/simulated-mail`, undefined, f.credentials.owner);
    assert.equal(newInbox.body.items.length, 1);
    const newToken = newInbox.body.items[0].token;
    assert.notEqual(newToken, verificationToken);
    assert.equal((await request('POST', '/api/public/subscriptions/verify', { token: verificationToken })).status, 400);
    assert.equal((await request('POST', '/api/public/subscriptions/verify', { token: newToken })).status, 200);
  } finally { ctx.config.env = priorEnv; }
});

test('alert failures remain undelivered, retry is durable and concurrent delivery and acknowledgement are idempotent', async () => {
  const f = await fixture();
  await request('POST', `${f.path}/services/${f.service._id}/incidents`, { title: 'Needs attention', message: 'Investigating' }, f.credentials.owner);
  const alert = await ctx.db.collection('alerts').findOne({ projectId: f.projectId });
  assert.ok(alert);
  assert.equal(await deliverPendingAlerts(ctx, { alertId: alert._id, simulateFailure: true }), 1);
  const failed = await ctx.db.collection('alerts').findOne({ _id: alert._id });
  assert.equal(failed?.deliveryState, 'failed');
  assert.equal(failed?.deliveredAt, undefined);
  assert.equal(await deliverPendingAlerts(ctx, { alertId: alert._id }), 0);
  const retryPath = `${f.path}/alerts/${alert._id}/retry`;
  assert.equal((await request('POST', retryPath, {}, f.credentials.viewer)).status, 403);
  const deliveries = await Promise.all([request('POST', retryPath, {}, f.credentials.owner), request('POST', retryPath, {}, f.credentials.responder)]);
  assert.deepEqual(deliveries.map(result => result.status), [200, 200]);
  assert.equal(await ctx.db.collection('alertAttempts').countDocuments({ alertId: alert._id }), 2);
  assert.equal(await ctx.db.collection('alertAttempts').countDocuments({ alertId: alert._id, outcome: 'delivered' }), 1);
  const ackPath = `${f.path}/alerts/${alert._id}/acknowledge`;
  assert.equal((await request('POST', ackPath, {}, f.credentials.viewer)).status, 403);
  const ack = await request('POST', ackPath, {}, f.credentials.responder);
  const repeated = await request('POST', ackPath, {}, f.credentials.owner);
  assert.equal(ack.status, 200);
  assert.equal(repeated.body.alert.acknowledgedBy, String(f.userIds.responder));
  assert.equal(await ctx.db.collection('auditEvents').countDocuments({ resourceId: alert._id, action: 'alert.acknowledged' }), 1);
});

test('automatic alert delivery stops after three failures and an authorized explicit retry can recover it', async () => {
  const f = await fixture();
  await request('POST', `${f.path}/services/${f.service._id}/incidents`, { title: 'Delivery retry budget', message: 'Investigating' }, f.credentials.owner);
  const alert = await ctx.db.collection('alerts').findOne({ projectId: f.projectId });
  assert.ok(alert);
  const originalNow = ctx.now;
  let current = ctx.now();
  ctx.now = () => new Date(current);
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(await deliverPendingAlerts(ctx, { alertId: alert._id, simulateFailure: true }), 1);
      current = new Date(current.getTime() + 60_000);
    }
    assert.equal(await deliverPendingAlerts(ctx, { alertId: alert._id }), 0);
    const exhausted = await ctx.db.collection('alerts').findOne({ _id: alert._id });
    assert.equal(exhausted?.deliveryState, 'failed');
    assert.equal(exhausted?.attempts, 3);
    assert.ok(exhausted?.retryExhaustedAt);
    assert.equal(exhausted?.nextAttemptAt, undefined);
    assert.equal(exhausted?.deliveredAt, undefined);
    assert.equal(exhausted?.acknowledgedAt, undefined);
    const retryPath = `${f.path}/alerts/${alert._id}/retry`;
    assert.equal((await request('POST', retryPath, {}, f.credentials.viewer)).status, 403);
    const recovered = await request('POST', retryPath, {}, f.credentials.responder);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.alert.deliveryState, 'delivered');
    assert.equal(recovered.body.alert.attempts, 4);
    assert.equal(recovered.body.alert.retryExhaustedAt, undefined);
    assert.equal(recovered.body.alert.acknowledgedAt, undefined);
    assert.equal(await ctx.db.collection('alertAttempts').countDocuments({ alertId: alert._id, outcome: 'failed' }), 3);
    assert.equal(await ctx.db.collection('alertAttempts').countDocuments({ alertId: alert._id, outcome: 'delivered' }), 1);
  } finally { ctx.now = originalNow; }
});

test('simulated payment failures preserve plan and concurrent successful retries activate exactly once', async () => {
  const f = await fixture();
  const path = `${f.path}/payments/simulate`;
  const body = { idempotencyKey: 'payment-retry-001', plan: 'advanced' };
  assert.equal((await request('POST', path, body, f.credentials.responder)).status, 403);
  const failed = await request('POST', path, { ...body, simulateFailure: true }, f.credentials.owner);
  assert.equal(failed.status, 200);
  assert.equal(failed.body.payment.state, 'failed');
  assert.equal((await ctx.db.collection('projects').findOne({ _id: f.projectId }))?.plan, 'free');
  const retries = await Promise.all([request('POST', path, body, f.credentials.owner), request('POST', path, body, f.credentials.owner)]);
  assert.deepEqual(retries.map(result => result.status), [200, 200]);
  assert.equal(retries[0]!.body.payment._id, retries[1]!.body.payment._id);
  assert.equal(retries[0]!.body.payment.attempts, 2);
  const replay = await request('POST', path, { ...body, simulateFailure: true }, f.credentials.owner);
  assert.equal(replay.body.payment.state, 'succeeded');
  assert.equal(replay.body.payment.attempts, 2);
  assert.equal(await ctx.db.collection('payments').countDocuments({ projectId: f.projectId }), 1);
  assert.equal(await ctx.db.collection('auditEvents').countDocuments({ projectId: f.projectId, action: 'plan.activated' }), 1);
  assert.equal((await ctx.db.collection('projects').findOne({ _id: f.projectId }))?.plan, 'advanced');
  assert.equal((await request('POST', path, { ...body, plan: 'free' }, f.credentials.owner)).status, 422);
  const other = await fixture();
  const concurrentInitial = await Promise.all([
    request('POST', `${other.path}/payments/simulate`, body, other.credentials.owner),
    request('POST', `${other.path}/payments/simulate`, body, other.credentials.owner),
  ]);
  assert.deepEqual(concurrentInitial.map(result => result.status), [200, 200]);
  assert.equal(concurrentInitial[0]!.body.payment.attempts, 1);
  assert.equal(concurrentInitial[1]!.body.payment._id, concurrentInitial[0]!.body.payment._id);
  assert.equal(await ctx.db.collection('auditEvents').countDocuments({ projectId: other.projectId, action: 'plan.activated' }), 1);
});

test('disabled simulation never records fictitious alert delivery or accepts unavailable email and payment flows', async () => {
  const f = await fixture();
  await request('POST', `${f.path}/services/${f.service._id}/incidents`, { title: 'Needs attention', message: 'Investigating' }, f.credentials.owner);
  const alert = await ctx.db.collection('alerts').findOne({ projectId: f.projectId });
  assert.ok(alert);
  const prior = ctx.config.simulations;
  ctx.config.simulations = false;
  try {
    assert.equal(await deliverPendingAlerts(ctx, { alertId: alert._id }), 0);
    assert.equal((await ctx.db.collection('alerts').findOne({ _id: alert._id }))?.deliveryState, 'pending');
    assert.equal((await request('POST', `${f.publicPath}/subscriptions`, { email: 'reader@example.test', serviceIds: [String(f.service._id)] })).status, 503);
    assert.equal((await request('POST', `${f.path}/payments/simulate`, { idempotencyKey: 'disabled-001', plan: 'advanced' }, f.credentials.owner)).status, 409);
  } finally { ctx.config.simulations = prior; }
});

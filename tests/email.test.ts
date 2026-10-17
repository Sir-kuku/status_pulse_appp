import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Server } from 'node:http';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createTestContext } from './helpers.js';
import { HttpError, hashToken, token, transaction, type AppContext } from '../src/core.js';
import { deliverPendingEmails, emailMode, queueEmail } from '../src/email.js';
import { deliverPendingAlerts, notifyPublicIncidentUpdate } from '../src/delivery.js';
import { projectRouter } from '../src/project-routes.js';
import { publicRouter } from '../src/public-routes.js';

let ctx: AppContext;
let close: () => Promise<void>;
let server: Server;
let base: string;
let now: Date;
let requests: { headers: Headers; body: any }[];
before(async () => {
  ({ ctx, close } = await createTestContext());
  const app = express();
  app.use(express.json());
  app.use('/api/public', publicRouter(ctx));
  app.use('/api', projectRouter(ctx));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({ code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await close?.(); });
beforeEach(async () => {
  for (const name of ['emailOutbox', 'emailAttempts', 'users', 'sessions', 'projects', 'services', 'memberships', 'invitations', 'subscriptions', 'notifications', 'incidents', 'incidentUpdates', 'alerts', 'alertAttempts', 'simulatedMail', 'accountTokens']) await ctx.db.collection(name).deleteMany({});
  now = new Date();
  ctx.now = () => new Date(now);
  ctx.config.env = 'production';
  ctx.config.emailMode = 'resend';
  ctx.config.resendApiKey = 'test-api-key-never-used-on-network';
  ctx.config.emailFrom = 'Status Pulse <updates@status.example.test>';
  ctx.config.publicBaseUrl = 'https://status.example.test';
  requests = [];
  ctx.emailFetch = async (_url, init) => {
    requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json({ id: `provider-${requests.length}` });
  };
});

const input = () => ({ kind: 'test-message', to: 'member@example.test', subject: 'An update', text: 'Only a test.', dedupeKey: `test:${new ObjectId()}` });
async function request(method: string, path: string, body?: unknown, bearer?: string) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() as any };
}
async function fixture() {
  const projectId = new ObjectId();
  const userId = new ObjectId();
  const bearer = token();
  await ctx.db.collection('users').insertOne({ _id: userId, email: 'owner@example.test', name: 'Project owner', emailVerifiedAt: now, platformRole: 'user' });
  await ctx.db.collection('sessions').insertOne({ userId, tokenHash: hashToken(bearer), expiresAt: new Date(now.getTime() + 3600_000) });
  await ctx.db.collection('projects').insertOne({ _id: projectId, name: 'Our workspace', slug: 'our-workspace', publicEnabled: true, ownerId: userId });
  await ctx.db.collection('memberships').insertOne({ projectId, userId, role: 'owner' });
  const serviceId = new ObjectId();
  await ctx.db.collection('services').insertOne({ _id: serviceId, projectId, name: 'Public API', publicVisible: true, enabled: true });
  return { projectId, userId, bearer, serviceId, invitationPath: `/api/projects/${projectId}/invitations`, subscriptionPath: '/api/public/projects/our-workspace/subscriptions' };
}

test('disabled delivery and production simulations fail explicitly without queuing email', async () => {
  ctx.config.emailMode = 'simulation';
  assert.equal(emailMode(ctx), 'disabled');
  await assert.rejects(queueEmail(ctx, undefined, input()), (error: unknown) => error instanceof HttpError && error.status === 503);
  assert.equal(await ctx.db.collection('emailOutbox').countDocuments(), 0);
  assert.equal(await deliverPendingEmails(ctx), 0);
  assert.equal(requests.length, 0);
});

test('duplicate queue requests and concurrent workers send exactly once and report provider acceptance honestly', async () => {
  const message = input();
  const first = await queueEmail(ctx, undefined, message);
  const second = await queueEmail(ctx, undefined, message);
  assert.ok(first.emailId.equals(second.emailId));
  await Promise.all([deliverPendingEmails(ctx), deliverPendingEmails(ctx), deliverPendingEmails(ctx)]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.headers.get('idempotency-key'), `status-pulse/${first.emailId}`);
  assert.deepEqual(requests[0]!.body.to, ['member@example.test']);
  const saved = await ctx.db.collection('emailOutbox').findOne({ _id: first.emailId });
  assert.equal(saved?.deliveryState, 'sent');
  assert.equal(saved?.providerId, 'provider-1');
  assert.ok(saved?.sentAt);
  assert.equal(saved?.deliveredAt, undefined);
  assert.equal(await ctx.db.collection('emailAttempts').countDocuments(), 1);
});

test('transient failures retry the frozen payload and idempotency key without leaking provider secrets', async () => {
  const message = await queueEmail(ctx, undefined, input());
  const goodFetch = ctx.emailFetch!;
  ctx.emailFetch = async (url, init) => { await goodFetch(url, init); return Response.json({ message: 'secret-token and recipient@example.test' }, { status: 503 }); };
  assert.equal(await deliverPendingEmails(ctx), 1);
  let saved = await ctx.db.collection('emailOutbox').findOne({ _id: message.emailId });
  assert.equal(saved?.deliveryState, 'retry');
  assert.equal(saved?.lastError, 'email_provider_http_503');
  assert.equal(saved?.sentAt, undefined);
  assert.equal(await deliverPendingEmails(ctx), 0);
  ctx.config.emailFrom = 'Changed <changed@example.test>';
  ctx.emailFetch = goodFetch;
  now = new Date(now.getTime() + 60_000);
  assert.equal(await deliverPendingEmails(ctx), 1);
  saved = await ctx.db.collection('emailOutbox').findOne({ _id: message.emailId });
  assert.equal(saved?.deliveryState, 'sent');
  assert.deepEqual(requests[0]!.body, requests[1]!.body);
  assert.equal(requests[0]!.headers.get('idempotency-key'), requests[1]!.headers.get('idempotency-key'));
  assert.doesNotMatch(JSON.stringify(await ctx.db.collection('emailAttempts').find().toArray()), /secret-token|recipient@example/);
});

test('permanent provider failures stop automatic retry and old ambiguous requests never cross provider dedupe expiry', async () => {
  const failed = await queueEmail(ctx, undefined, input());
  ctx.emailFetch = async () => Response.json({ message: 'bad sender' }, { status: 403 });
  await deliverPendingEmails(ctx);
  assert.equal((await ctx.db.collection('emailOutbox').findOne({ _id: failed.emailId }))?.deliveryState, 'failed');
  assert.equal(await deliverPendingEmails(ctx), 0);
  const ambiguous = await queueEmail(ctx, undefined, input());
  await ctx.db.collection('emailOutbox').updateOne({ _id: ambiguous.emailId }, { $set: { deliveryState: 'sending', leaseUntil: new Date(0), firstAttemptAt: new Date(now.getTime() - 24 * 3600_000) } });
  let calls = 0;
  ctx.emailFetch = async () => { calls++; return Response.json({ id: 'must-not-send' }); };
  await deliverPendingEmails(ctx);
  assert.equal(calls, 0);
  assert.equal((await ctx.db.collection('emailOutbox').findOne({ _id: ambiguous.emailId }))?.lastError, 'email_retry_window_expired');
});

test('expired worker leases recover safely and a final abandoned lease becomes terminal', async () => {
  const queued = await queueEmail(ctx, undefined, input());
  await ctx.db.collection('emailOutbox').updateOne({ _id: queued.emailId }, { $set: { deliveryState: 'sending', leaseUntil: new Date(0), firstAttemptAt: now, attempts: 1 } });
  assert.equal(await deliverPendingEmails(ctx), 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.headers.get('idempotency-key'), `status-pulse/${queued.emailId}`);
  const abandoned = await queueEmail(ctx, undefined, input());
  await ctx.db.collection('emailOutbox').updateOne({ _id: abandoned.emailId }, { $set: { deliveryState: 'sending', leaseUntil: new Date(0), firstAttemptAt: now, attempts: 6 } });
  await deliverPendingEmails(ctx);
  assert.equal(requests.length, 1);
  assert.equal((await ctx.db.collection('emailOutbox').findOne({ _id: abandoned.emailId }))?.deliveryState, 'failed');
});

test('superseded account links and expired invitations are cancelled before provider calls', async () => {
  const f = await fixture();
  const expired = new ObjectId();
  await ctx.db.collection('invitations').insertOne({ _id: expired, tokenHash: hashToken(token()), projectId: f.projectId, expiresAt: new Date(0) });
  await queueEmail(ctx, undefined, { ...input(), invitationId: expired, projectId: f.projectId });
  await queueEmail(ctx, undefined, { ...input(), userId: f.userId, accountTokenHash: hashToken(token()) });
  await deliverPendingEmails(ctx);
  assert.equal(requests.length, 0);
  assert.equal(await ctx.db.collection('emailOutbox').countDocuments({ deliveryState: 'cancelled' }), 2);
});

test('real invitations enforce sender verification, keep tokens out of responses and cannot reuse old simulated invitations', async () => {
  const f = await fixture();
  await ctx.db.collection('users').updateOne({ _id: f.userId }, { $unset: { emailVerifiedAt: '' } });
  assert.equal((await request('POST', f.invitationPath, { email: 'teammate@example.test', role: 'viewer' }, f.bearer)).status, 403);
  await ctx.db.collection('users').updateOne({ _id: f.userId }, { $set: { emailVerifiedAt: now } });
  const response = await request('POST', f.invitationPath, { email: 'teammate@example.test', role: 'viewer' }, f.bearer);
  assert.equal(response.status, 201);
  assert.equal(response.body.simulatedEmail, undefined);
  assert.deepEqual(response.body.delivery, { state: 'queued', simulation: false });
  assert.equal(await ctx.db.collection('simulatedMail').countDocuments(), 0);
  await deliverPendingEmails(ctx);
  assert.match(requests[0]!.body.text, /https:\/\/status\.example\.test\/#invite=[A-Za-z0-9_-]{43}/);
  assert.equal((await request('POST', f.invitationPath, { email: 'teammate@example.test', role: 'viewer' }, f.bearer)).status, 429);
  const oldToken = token();
  await ctx.db.collection('invitations').insertOne({ tokenHash: hashToken(oldToken), projectId: new ObjectId(), email: 'owner@example.test', role: 'viewer', expiresAt: new Date(now.getTime() + 3600_000) });
  assert.equal((await request('POST', '/api/invitations/accept', { token: oldToken }, f.bearer)).status, 400);
});

test('real subscription confirmation replaces simulated ownership and unsubscribe cancels queued notifications', async () => {
  const f = await fixture();
  await ctx.db.collection('subscriptions').insertOne({ projectId: f.projectId, email: 'reader@example.test', serviceIds: [f.serviceId], verifiedAt: now, verificationMethod: 'simulation' });
  const signup = await request('POST', f.subscriptionPath, { email: 'reader@example.test', serviceIds: [String(f.serviceId)] });
  assert.equal(signup.status, 202);
  assert.equal(signup.body.simulation, false);
  assert.equal(signup.body.simulatedEmail, undefined);
  const subscriber = await ctx.db.collection('subscriptions').findOne({ projectId: f.projectId });
  assert.equal(subscriber?.verifiedAt, undefined);
  await deliverPendingEmails(ctx);
  const verification = requests[0]!.body.text.match(/#verify=([A-Za-z0-9_-]{43})/)[1];
  assert.equal((await request('POST', '/api/public/subscriptions/verify', { token: verification })).body.simulation, false);
  assert.equal((await request('POST', '/api/public/subscriptions/verify', { token: verification })).status, 400);
  const incident = { _id: new ObjectId(), projectId: f.projectId, serviceId: f.serviceId, publicVisible: true, title: 'Service incident' };
  await ctx.db.collection('incidents').insertOne(incident);
  const update = { _id: new ObjectId(), incidentId: incident._id, projectId: f.projectId, serviceId: f.serviceId, publicVisible: true, state: 'identified', message: 'The cause is understood.' };
  await transaction(ctx, session => notifyPublicIncidentUpdate(ctx, session, update));
  await transaction(ctx, session => notifyPublicIncidentUpdate(ctx, session, update));
  assert.equal(await ctx.db.collection('notifications').countDocuments(), 1);
  await deliverPendingEmails(ctx);
  const notice = requests.at(-1)!;
  const unsubscribe = notice.body.text.match(/#unsubscribe=([A-Za-z0-9_-]{43})/)[1];
  assert.match(notice.body.html, /href="https:\/\/status\.example\.test\/status\/our-workspace#unsubscribe=/);
  await transaction(ctx, session => notifyPublicIncidentUpdate(ctx, session, { ...update, _id: new ObjectId(), message: 'More news' }));
  assert.equal((await request('POST', '/api/public/subscriptions/unsubscribe', { token: unsubscribe })).status, 200);
  const sent = requests.length;
  await deliverPendingEmails(ctx);
  assert.equal(requests.length, sent);
  assert.equal(await ctx.db.collection('emailOutbox').countDocuments({ kind: 'incident-update', deliveryState: 'cancelled' }), 1);
  await request('POST', f.subscriptionPath, { email: 'reader@example.test', serviceIds: [String(f.serviceId)] });
  await request('POST', '/api/public/subscriptions/unsubscribe', { token: unsubscribe });
  assert.equal((await ctx.db.collection('subscriptions').findOne({ _id: subscriber!._id }))?.revokedAt, undefined);
});

test('public visibility is rechecked when sending incident notifications', async () => {
  const f = await fixture();
  const subscriptionId = new ObjectId();
  await ctx.db.collection('subscriptions').insertOne({ _id: subscriptionId, projectId: f.projectId, email: 'reader@example.test', serviceIds: [f.serviceId], verifiedAt: now, verificationMethod: 'email' });
  await queueEmail(ctx, undefined, { ...input(), kind: 'incident-update', projectId: f.projectId, subscriptionId, serviceId: f.serviceId });
  await ctx.db.collection('services').updateOne({ _id: f.serviceId }, { $set: { publicVisible: false } });
  await deliverPendingEmails(ctx);
  assert.equal(requests.length, 0);
  assert.equal((await ctx.db.collection('emailOutbox').findOne({}))?.deliveryState, 'cancelled');
});

test('monitor alerts send separately to verified responders and retain distinct attempt audit records', async () => {
  const f = await fixture();
  const responderId = new ObjectId();
  await ctx.db.collection('users').insertOne({ _id: responderId, email: 'responder@example.test', name: 'Responder', emailVerifiedAt: now });
  await ctx.db.collection('memberships').insertOne({ projectId: f.projectId, userId: responderId, role: 'responder' });
  const incidentId = new ObjectId();
  await ctx.db.collection('incidents').insertOne({ _id: incidentId, projectId: f.projectId, title: 'Service unavailable' });
  const alertId = new ObjectId();
  await ctx.db.collection('alerts').insertOne({ _id: alertId, projectId: f.projectId, incidentId, deliveryState: 'pending', attempts: 0, dedupeKey: `alert:${alertId}` });
  await deliverPendingAlerts(ctx, { alertId });
  assert.equal(requests.length, 2);
  const alert = await ctx.db.collection('alerts').findOne({ _id: alertId });
  assert.equal(alert?.deliveryState, 'sent');
  assert.equal(alert?.deliveredAt, undefined);
  assert.equal(await ctx.db.collection('alertAttempts').countDocuments({ alertId }), 2);
  await deliverPendingAlerts(ctx, { alertId, force: true });
  assert.equal(requests.length, 2);
});

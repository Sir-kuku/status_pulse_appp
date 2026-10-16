import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { ObjectId } from 'mongodb';
import { createTestContext } from '../tests/helpers.js';
import { createApp } from '../src/app.js';
import { runNextCheck, scheduleDue, expireOverridesAndRecordStale } from '../src/monitoring.js';
import { deliverPendingAlerts } from '../src/delivery.js';
import type { CheckOutcome } from '../src/endpoint-checker.js';

const { ctx, close } = await createTestContext();
const server = createApp(ctx).listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
let now = new Date(); ctx.now = () => new Date(now);
const evidence: { scenario: string; result: 'passed' }[] = [];
function pass(scenario: string) { evidence.push({ scenario, result: 'passed' }); console.log(`PASS: ${scenario}`); }
async function api(method: string, route: string, body?: unknown, token?: string, expected = 200): Promise<any> {
  const result = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const content = await result.text();
  assert.equal(result.status, expected, `${method} ${route}: ${content}`);
  return content ? JSON.parse(content) : undefined;
}
try {
  const password = 'a long isolated demo passphrase';
  const owner = await api('POST', '/api/auth/register', { name: 'Demo Owner', email: 'owner@example.test', password }, undefined, 201);
  const viewer = await api('POST', '/api/auth/register', { name: 'Demo Viewer', email: 'viewer@example.test', password }, undefined, 201);
  const outsider = await api('POST', '/api/auth/register', { name: 'Outsider', email: 'outsider@example.test', password }, undefined, 201);
  const { project } = await api('POST', '/api/projects', { name: 'Status Pulse Demo', slug: 'status-pulse-demo', publicEnabled: true }, owner.token, 201);
  const projectPath = `/api/projects/${project._id}`;
  const invite = await api('POST', `${projectPath}/invitations`, { email: viewer.user.email, role: 'viewer' }, owner.token, 201);
  await api('POST', '/api/invitations/accept', { token: invite.simulatedEmail.token }, viewer.token, 201);
  await api('GET', projectPath, undefined, outsider.token, 404);
  await api('PATCH', projectPath, { version: 1, name: 'Forbidden' }, viewer.token, 403);
  pass('Project roles and cross-project privacy');
  const { service } = await api('POST', `${projectPath}/services`, { name: 'Public API', url: 'https://example.com/health', publicVisible: true }, owner.token, 201);
  const servicePath = `${projectPath}/services/${service._id}`;
  await api('POST', `${projectPath}/services`, { name: 'Private API', url: 'https://example.com/private?token=demo-private', enabled: false }, owner.token, 201);
  const signup = await api('POST', '/api/public/projects/status-pulse-demo/subscriptions', { email: 'subscriber@example.test', serviceIds: [service._id] }, undefined, 202);
  await api('POST', '/api/public/subscriptions/verify', { token: signup.simulatedEmail.verificationToken });
  pass('Selected-service subscription with simulated verification');
  const healthy: CheckOutcome = { success: true, httpStatus: 200, latencyMs: 80, failureReason: null };
  const down: CheckOutcome = { success: false, httpStatus: null, latencyMs: 5000, failureReason: 'timeout' };
  async function tick(outcome: CheckOutcome) {
    now = new Date(now.getTime() + 60000);
    const scheduled = await Promise.all([scheduleDue(ctx), scheduleDue(ctx)]);
    assert.equal(scheduled.reduce((a, b) => a + b, 0), 1);
    await Promise.all([runNextCheck(ctx, async () => outcome), runNextCheck(ctx, async () => outcome)]);
  }
  await tick(healthy); await tick(healthy);
  assert.equal((await api('GET', servicePath, undefined, owner.token)).service.status, 'operational');
  pass('Scheduled healthy checks and recovery threshold');
  await tick(down); await tick(down); await tick(down); await tick(down);
  assert.equal(await ctx.db.collection('incidents').countDocuments({ active: true }), 1);
  assert.equal(await ctx.db.collection('alerts').countDocuments(), 1);
  assert.equal(await ctx.db.collection('checkResults').countDocuments(), 6);
  assert.equal((await api('GET', servicePath, undefined, owner.token)).service.status, 'outage');
  pass('Timeout outage, concurrent scheduling, and incident/alert deduplication');
  await deliverPendingAlerts(ctx, { simulateFailure: true });
  const alert = (await api('GET', `${projectPath}/alerts`, undefined, owner.token)).items[0];
  assert.equal(alert.deliveryState, 'failed');
  await api('POST', `${projectPath}/alerts/${alert._id}/retry`, { simulateFailure: false }, owner.token);
  await api('POST', `${projectPath}/alerts/${alert._id}/acknowledge`, {}, owner.token);
  pass('Failed alert retry and separate acknowledgement');
  await api('PUT', `${servicePath}/override`, { status: 'degraded', reason: 'Demo investigation in progress', expiresAt: new Date(now.getTime() + 60000).toISOString() }, owner.token);
  assert.equal((await api('GET', servicePath, undefined, owner.token)).service.status, 'degraded');
  now = new Date(now.getTime() + 61000); await expireOverridesAndRecordStale(ctx);
  assert.equal((await api('GET', servicePath, undefined, owner.token)).service.status, 'outage');
  pass('Audited manual override and automatic expiry');
  await tick(healthy); await tick(healthy);
  let incident = (await api('GET', `${projectPath}/incidents`, undefined, owner.token)).items[0];
  assert.equal(incident.state, 'investigating');
  for (const state of ['identified', 'monitoring', 'resolved']) {
    const changed = await api('POST', `${projectPath}/incidents/${incident._id}/updates`, { version: incident.version, state, message: `Demo public update: ${state}`, publicVisible: true }, owner.token, 201);
    incident = changed.incident;
  }
  assert.equal(incident.active, false);
  assert.ok(await ctx.db.collection('notifications').countDocuments({ deliveryState: 'delivered' }) >= 4);
  pass('Healthy recovery evidence, explicit incident lifecycle, and subscriber notifications');
  const page = await api('GET', '/api/public/projects/status-pulse-demo');
  assert.equal(page.services.length, 1);
  assert.doesNotMatch(JSON.stringify(page), /demo-private|url|tokenHash|passwordHash|override/);
  pass('Public status excludes private services and configuration');
  const payment = { idempotencyKey: 'demo-upgrade-001', plan: 'advanced', simulateFailure: true };
  await api('POST', `${projectPath}/payments/simulate`, payment, owner.token);
  assert.equal((await api('GET', projectPath, undefined, owner.token)).project.plan, 'free');
  payment.simulateFailure = false;
  await api('POST', `${projectPath}/payments/simulate`, payment, owner.token);
  await api('POST', `${projectPath}/payments/simulate`, payment, owner.token);
  assert.equal((await api('GET', projectPath, undefined, owner.token)).project.plan, 'advanced');
  assert.equal(await ctx.db.collection('payments').countDocuments(), 1);
  assert.equal(await ctx.db.collection('auditEvents').countDocuments({ action: 'plan.activated' }), 1);
  pass('Failed payment leaves plan unchanged; successful retry activates once');
  now = new Date(now.getTime() + 181000); await expireOverridesAndRecordStale(ctx);
  assert.equal((await api('GET', servicePath, undefined, owner.token)).service.status, 'unknown');
  await api('GET', '/api/admin/operations', undefined, owner.token, 403);
  await ctx.db.collection('users').updateOne({ _id: new ObjectId(owner.user._id) }, { $set: { platformRole: 'admin' } });
  await api('GET', '/api/admin/operations', undefined, owner.token);
  pass('Stale results become unknown and administration is restricted');
  await mkdir('docs/evidence', { recursive: true });
  await writeFile('docs/evidence/local-demo.json', JSON.stringify({ verifiedAt: new Date().toISOString(), environment: 'isolated local MongoDB replica set', transport: 'controlled checker outcomes; no external endpoint requests', hostedDeploymentVerified: false, scenarios: evidence }, null, 2) + '\n');
  console.log('Acceptance demo complete. Evidence: docs/evidence/local-demo.json');
} finally { await new Promise<void>(resolve => server.close(() => resolve())); await close(); }

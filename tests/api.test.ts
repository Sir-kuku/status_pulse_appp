import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { ObjectId } from 'mongodb';
import { createTestContext } from './helpers.js';
import { createApp } from '../src/app.js';
import { type AppContext, hashToken } from '../src/core.js';

let ctx: AppContext;
let close: () => Promise<void>;
let server: Server;
let base: string;
before(async () => {
  ({ ctx, close } = await createTestContext());
  server = createApp(ctx).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); if (close) await close(); });
async function request(method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as any : null };
}
const password = 'a long test-only password 123!';
async function register(name: string) {
  const email = `${name}-${new ObjectId()}@example.test`;
  const response = await request('POST', '/api/auth/register', { name, email, password });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { ...response.body, email } as { user: { _id: string }; token: string; email: string };
}
async function createProject(token: string, publicEnabled = false) {
  const response = await request('POST', '/api/projects', { name: 'Status Pulse API test', slug: `test-${new ObjectId()}`, publicEnabled }, token);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.project as { _id: string; slug: string; version: number };
}
async function invite(projectId: string, ownerToken: string, account: { token: string; email: string }, role: 'viewer' | 'responder') {
  const invitation = await request('POST', `/api/projects/${projectId}/invitations`, { email: account.email, role }, ownerToken);
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const accepted = await request('POST', '/api/invitations/accept', { token: invitation.body.simulatedEmail.token }, account.token);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  return invitation.body.simulatedEmail.token as string;
}

test('health, API contract, administrator access and public HTML have correct visibility and escaping', async () => {
  assert.equal((await request('GET', '/health/ready')).status, 200);
  const spec = await request('GET', '/api/openapi.json');
  assert.equal(spec.body.openapi, '3.0.3');
  assert.ok(spec.body.paths['/api/admin/operations']);
  const owner = await register('htmlowner');
  assert.equal((await request('GET', '/api/admin/operations', undefined, owner.token)).status, 403);
  await ctx.db.collection('users').updateOne({ _id: new ObjectId(owner.user._id) }, { $set: { platformRole: 'admin' } });
  assert.equal((await request('GET', '/api/admin/operations', undefined, owner.token)).status, 200);
  assert.equal((await request('GET', '/api/admin/audit', undefined, owner.token)).status, 200);
  const project = await createProject(owner.token, true);
  await request('POST', `/api/projects/${project._id}/services`, { name: '<script>alert(1)</script>', url: 'https://example.com/secret-path', publicVisible: true }, owner.token);
  await request('POST', `/api/projects/${project._id}/services`, { name: 'Hidden service', url: 'https://example.com/private' }, owner.token);
  const page = await fetch(`${base}/status/${project.slug}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|Hidden service|secret-path/);
  await request('PATCH', `/api/projects/${project._id}`, { version: 1, publicEnabled: false }, owner.token);
  assert.equal((await fetch(`${base}/status/${project.slug}`)).status, 404);
  const invalidJson = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json() as any).error.code, 'INVALID_JSON');
});

test('accounts validate inputs, normalize identity, store only hashes and revoke bearer sessions on logout', async () => {
  assert.equal((await request('POST', '/api/auth/register', { name: 'Bad', email: 'invalid', password })).status, 422);
  assert.equal((await request('POST', '/api/auth/register', { name: 'Bad', email: 'valid@example.test', password: 'short' })).status, 422);
  assert.equal((await request('POST', '/api/auth/register', { name: 'Bad', email: 'valid@example.test', password, platformRole: 'admin' })).status, 422);
  const email = `User-${new ObjectId()}@Example.test`;
  const response = await request('POST', '/api/auth/register', { name: '  User  ', email: ` ${email} `, password });
  assert.equal(response.status, 201);
  assert.equal(response.body.user.email, email.toLowerCase());
  assert.equal(response.body.user.name, 'User');
  assert.equal(response.body.user.platformRole, 'user');
  assert.equal(response.body.user.passwordHash, undefined);
  const stored = await ctx.db.collection('users').findOne({ _id: new ObjectId(response.body.user._id) });
  assert.ok(stored?.passwordHash.startsWith('scrypt$32768$'));
  assert.notEqual(stored?.passwordHash, password);
  const session = await ctx.db.collection('sessions').findOne({ userId: stored!._id });
  assert.equal(session?.tokenHash, hashToken(response.body.token));
  assert.equal(session?.token, undefined);
  assert.equal((await request('POST', '/api/auth/register', { name: 'Again', email: email.toLowerCase(), password })).status, 409);
  assert.equal((await request('POST', '/api/auth/login', { email, password: 'incorrect password' })).status, 401);
  assert.equal((await request('POST', '/api/auth/login', { email: 'unknown@example.test', password })).status, 401);
  const login = await request('POST', '/api/auth/login', { email, password });
  assert.equal(login.status, 200);
  assert.notEqual(login.body.token, response.body.token);
  assert.equal((await request('GET', '/api/auth/me', undefined, login.body.token)).status, 200);
  assert.equal((await request('POST', '/api/auth/logout', {}, login.body.token)).status, 204);
  assert.equal((await request('GET', '/api/auth/me', undefined, login.body.token)).status, 401);
  await ctx.db.collection('sessions').updateOne({ tokenHash: hashToken(response.body.token) }, { $set: { expiresAt: new Date(0) } });
  assert.equal((await request('GET', '/api/auth/me', undefined, response.body.token)).status, 401);
});

test('project membership is invitation-bound, role gated and isolated across projects', async () => {
  const owner = await register('owner');
  const responder = await register('responder');
  const viewer = await register('viewer');
  const outsider = await register('outsider');
  const project = await createProject(owner.token);
  const path = `/api/projects/${project._id}`;
  assert.equal((await request('GET', path)).status, 401);
  assert.equal((await request('GET', path, undefined, outsider.token)).status, 404);
  assert.equal((await request('GET', '/api/projects', undefined, outsider.token)).body.projects.length, 0);
  const invitation = await request('POST', `${path}/invitations`, { email: responder.email.toUpperCase(), role: 'responder' }, owner.token);
  assert.equal(invitation.status, 201);
  const invitationToken = invitation.body.simulatedEmail.token;
  assert.equal((await request('POST', '/api/invitations/accept', { token: invitationToken }, outsider.token)).status, 400);
  assert.equal((await request('POST', '/api/invitations/accept', { token: invitationToken }, responder.token)).status, 201);
  assert.equal((await request('POST', '/api/invitations/accept', { token: invitationToken }, responder.token)).status, 400);
  await invite(project._id, owner.token, viewer, 'viewer');
  assert.equal((await request('GET', path, undefined, viewer.token)).status, 200);
  assert.equal((await request('PATCH', path, { version: 1, name: 'Denied' }, viewer.token)).status, 403);
  assert.equal((await request('POST', `${path}/invitations`, { email: outsider.email, role: 'viewer' }, responder.token)).status, 403);
  assert.equal((await request('GET', `${path}/members`, undefined, viewer.token)).status, 403);
  const members = await request('GET', `${path}/members`, undefined, owner.token);
  assert.equal(members.body.members.length, 3);
  assert.doesNotMatch(JSON.stringify(members.body), /passwordHash|tokenHash/);
  assert.equal((await request('PATCH', `${path}/members/${owner.user._id}`, { role: 'viewer' }, owner.token)).status, 404);
  assert.equal((await request('DELETE', `${path}/members/${owner.user._id}`, undefined, owner.token)).status, 404);
  const changed = await request('PATCH', path, { version: 1, name: 'Updated' }, owner.token);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.project.version, 2);
  assert.equal((await request('PATCH', path, { version: 1, name: 'Stale update' }, owner.token)).status, 409);
  assert.equal((await request('DELETE', `${path}/members/${viewer.user._id}`, undefined, owner.token)).status, 204);
  assert.equal((await request('GET', path, undefined, viewer.token)).status, 404);
});

test('invitation reissue expires the old token, and expired invitations cannot grant access', async () => {
  const owner = await register('inviteowner');
  const member = await register('invitemember');
  const project = await createProject(owner.token);
  const path = `/api/projects/${project._id}/invitations`;
  const first = await request('POST', path, { email: member.email, role: 'responder' }, owner.token);
  const second = await request('POST', path, { email: member.email, role: 'viewer' }, owner.token);
  assert.equal((await request('POST', '/api/invitations/accept', { token: first.body.simulatedEmail.token }, member.token)).status, 400);
  await ctx.db.collection('invitations').updateOne({ _id: new ObjectId(second.body.invitation._id) }, { $set: { expiresAt: new Date(0) } });
  assert.equal((await request('POST', '/api/invitations/accept', { token: second.body.simulatedEmail.token }, member.token)).status, 400);
  assert.equal((await request('GET', `/api/projects/${project._id}`, undefined, member.token)).status, 404);
});

test('service configuration validates endpoints and ranges, preserves omitted PATCH fields and rejects stale writes', async () => {
  const owner = await register('serviceowner');
  const responder = await register('serviceresponder');
  const viewer = await register('serviceviewer');
  const project = await createProject(owner.token);
  await invite(project._id, owner.token, responder, 'responder');
  await invite(project._id, owner.token, viewer, 'viewer');
  const path = `/api/projects/${project._id}/services`;
  const input = { name: 'Health check', url: 'https://example.com/health', method: 'HEAD', enabled: false, intervalSeconds: 120,
    timeoutMs: 4000, expectedStatusMin: 201, expectedStatusMax: 204, slowThresholdMs: 800, failureThreshold: 5, recoveryThreshold: 4, publicVisible: true };
  assert.equal((await request('POST', path, input, responder.token)).status, 403);
  assert.equal((await request('POST', path, input, viewer.token)).status, 403);
  assert.equal((await request('POST', path, { ...input, url: 'http://127.0.0.1/health' }, owner.token)).status, 422);
  assert.equal((await request('POST', path, { ...input, url: 'https://user:secret@example.com' }, owner.token)).status, 422);
  assert.equal((await request('POST', path, { ...input, expectedStatusMin: 400 }, owner.token)).status, 422);
  assert.equal((await request('POST', path, { ...input, slowThresholdMs: 5000 }, owner.token)).status, 422);
  assert.equal((await request('POST', path, { ...input, intervalSeconds: 30 }, owner.token)).status, 422);
  assert.equal((await request('POST', path, { ...input, unexpected: true }, owner.token)).status, 422);
  const created = await request('POST', path, input, owner.token);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const servicePath = `${path}/${created.body.service._id}`;
  assert.equal((await request('GET', servicePath, undefined, viewer.token)).status, 200);
  assert.equal((await request('PATCH', servicePath, { version: 1, name: 'Denied' }, responder.token)).status, 403);
  const renamed = await request('PATCH', servicePath, { version: 1, name: 'Renamed' }, owner.token);
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.service.configVersion, 2);
  for (const key of Object.keys(input).filter(key => key !== 'name')) assert.equal(renamed.body.service[key], input[key as keyof typeof input], `PATCH preserved ${key}`);
  assert.equal((await request('PATCH', servicePath, { version: 1, name: 'Stale' }, owner.token)).status, 409);
  const races = await Promise.all([
    request('PATCH', servicePath, { version: 2, name: 'Winner A' }, owner.token),
    request('PATCH', servicePath, { version: 2, name: 'Winner B' }, owner.token),
  ]);
  assert.deepEqual(races.map(result => result.status).sort(), [200, 409]);
  const versions = await request('GET', `${servicePath}/config-versions`, undefined, owner.token);
  assert.equal(versions.body.versions.length, 3);
  assert.equal((await request('GET', `${servicePath}/config-versions`, undefined, viewer.token)).status, 403);
  const otherProject = await createProject(owner.token);
  assert.equal((await request('GET', `/api/projects/${otherProject._id}/services/${created.body.service._id}`, undefined, owner.token)).status, 404);
  assert.equal((await request('GET', `${path}?limit=101`, undefined, owner.token)).status, 422);
  assert.equal((await request('GET', `${path}/invalid-id`, undefined, owner.token)).status, 400);
});

test('manual checks and overrides enforce roles, future expiry and current service availability', async () => {
  const owner = await register('overrideowner');
  const responder = await register('overrideresponder');
  const viewer = await register('overrideviewer');
  const project = await createProject(owner.token, true);
  await invite(project._id, owner.token, responder, 'responder');
  await invite(project._id, owner.token, viewer, 'viewer');
  const created = await request('POST', `/api/projects/${project._id}/services`, { name: 'Monitored API', url: 'https://example.com/health', publicVisible: true }, owner.token);
  assert.equal(created.status, 201);
  const path = `/api/projects/${project._id}/services/${created.body.service._id}`;
  const override = { status: 'degraded', reason: 'Planned database maintenance', expiresAt: new Date(ctx.now().getTime() + 3600000).toISOString() };
  assert.equal((await request('PUT', `${path}/override`, override, viewer.token)).status, 403);
  assert.equal((await request('PUT', `${path}/override`, { ...override, expiresAt: new Date(0).toISOString() }, responder.token)).status, 422);
  assert.equal((await request('PUT', `${path}/override`, { ...override, expiresAt: new Date(ctx.now().getTime() + 2 * 86400000).toISOString() }, responder.token)).status, 422);
  const overridden = await request('PUT', `${path}/override`, override, responder.token);
  assert.equal(overridden.status, 200);
  assert.equal(overridden.body.service.status, 'degraded');
  assert.equal(overridden.body.service.override.actorId, responder.user._id);
  const page = await request('GET', `/api/public/projects/${project.slug}`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.services[0].status, 'degraded');
  assert.doesNotMatch(JSON.stringify(page.body), /Planned database maintenance|actorId|url/);
  assert.equal((await request('POST', `${path}/checks`, {}, viewer.token)).status, 403);
  assert.equal((await request('POST', `${path}/checks`, {}, responder.token)).status, 202);
  assert.equal((await request('DELETE', `${path}/override`, undefined, responder.token)).status, 204);
  assert.equal((await request('GET', path, undefined, owner.token)).body.service.status, 'unknown');
  assert.equal((await request('PATCH', path, { version: 1, enabled: false }, owner.token)).status, 200);
  assert.equal((await request('POST', `${path}/checks`, {}, responder.token)).status, 409);
  const historyBefore = await ctx.db.collection('statusHistory').countDocuments({ serviceId: new ObjectId(created.body.service._id) });
  assert.ok(historyBefore >= 2);
  assert.equal((await request('DELETE', path, undefined, owner.token)).status, 204);
  assert.equal((await request('GET', path, undefined, owner.token)).status, 404);
  assert.equal(await ctx.db.collection('statusHistory').countDocuments({ serviceId: new ObjectId(created.body.service._id) }), historyBefore);
  assert.ok((await ctx.db.collection('services').findOne({ _id: new ObjectId(created.body.service._id) }))?.archivedAt);
});

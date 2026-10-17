import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import express, { type ErrorRequestHandler } from 'express';
import { ObjectId } from 'mongodb';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ZodError } from 'zod';
import { createTestContext } from './helpers.js';
import { authRouter } from '../src/auth-routes.js';
import { fetchProviderIdentity } from '../src/oauth.js';
import { hashToken, HttpError, token, type AppContext } from '../src/core.js';

let ctx: AppContext, close: () => Promise<void>, server: Server, base: string;
let providerEmail = '', providerId = 1000, providerVerified = true, providerCalls = 0;
const password = 'a long test-only password 123!';
const providerFetch: typeof fetch = async (url, init) => {
  providerCalls++;
  const address = String(url);
  if (address === 'https://github.com/login/oauth/access_token') {
    const params = new URLSearchParams(String(init?.body));
    assert.ok(params.get('code_verifier'));
    assert.equal(params.get('redirect_uri'), `${ctx.config.publicBaseUrl}/api/auth/oauth/github/callback`);
    return Response.json({ access_token: 'provider-test-access', token_type: 'bearer' });
  }
  assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer provider-test-access');
  if (address === 'https://api.github.com/user') return Response.json({ id: providerId, login: 'octocat', name: 'OAuth account' });
  if (address === 'https://api.github.com/user/emails?per_page=100') return Response.json([{ email: providerEmail, primary: true, verified: providerVerified }]);
  throw new Error('Unexpected provider endpoint');
};

before(async () => {
  ({ ctx, close } = await createTestContext());
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error instanceof HttpError ? error.status : error instanceof ZodError ? 422 : error?.code === 11000 ? 409 : 500)
      .json({ error: { code: error.code ?? 'VALIDATION_ERROR', message: error.message } });
  };
  server = express().use(express.json()).use('/api/auth', authRouter(ctx, { fetch: providerFetch })).use(errors).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  ctx.config.publicBaseUrl = base;
});
after(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); if (close) await close(); });
async function request(method: string, path: string, body?: unknown, bearer?: string, cookie?: string) {
  const response = await fetch(`${base}/api/auth${path}`, { method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: response.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) as any : null,
    location: response.headers.get('location'), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
}
async function register() {
  const email = `account-${new ObjectId()}@example.test`;
  const result = await request('POST', '/register', { name: 'Auth test', email, password });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return { ...result.body, email } as { user: { _id: string; emailVerified: boolean }; token: string; email: string; verificationEmail: { status: string } };
}
async function mailToken(email: string, kind: 'verification' | 'reset') {
  const mail = await ctx.db.collection('emailOutbox').findOne({ to: email, kind: kind === 'verification' ? 'account-verification' : 'password-reset' }, { sort: { createdAt: -1 } });
  assert.ok(mail);
  const value = String(mail.text).match(new RegExp(`#${kind === 'verification' ? 'verify_email' : 'reset_password'}=([A-Za-z0-9_-]{43})`))?.[1];
  assert.ok(value);
  return value;
}
async function start(bearer?: string) {
  const result = await request(bearer ? 'POST' : 'GET', `/oauth/github/${bearer ? 'link' : 'start'}`, bearer ? {} : undefined, bearer);
  assert.equal(result.status, bearer ? 200 : 303);
  const url = new URL(bearer ? result.body.url : result.location!);
  return { ...result, url, state: url.searchParams.get('state')! };
}
async function callback(flow: Awaited<ReturnType<typeof start>>, cookie = flow.cookie) {
  return request('GET', `/oauth/github/callback?${new URLSearchParams({ state: flow.state, code: 'test-code' })}`, undefined, undefined, cookie);
}

test('auth discovery does not advertise unconfigured providers or email delivery', async () => {
  ctx.config.emailMode = 'disabled';
  const options = await request('GET', '/options');
  assert.deepEqual(options.body.providers, []);
  assert.deepEqual(options.body.email, { enabled: false, mode: 'disabled' });
  assert.ok(options.body.branding.creatorName);
  assert.equal((await request('GET', '/oauth/google/start')).status, 503);
  assert.equal((await request('POST', '/forgot-password', { email: 'unknown@example.test' })).status, 503);
  const account = await register();
  assert.equal(account.verificationEmail.status, 'unavailable');
  assert.equal(await ctx.db.collection('emailOutbox').countDocuments({ to: account.email }), 0);
  ctx.config.emailMode = 'resend';
  ctx.config.resendApiKey = 'test-only-provider-key';
  ctx.config.emailFrom = 'Status Pulse <test@example.test>';
});

test('registration queues a real-mode verification link, stores its hash and consumes it only once', async () => {
  const account = await register();
  assert.equal(account.user.emailVerified, false);
  assert.equal(account.verificationEmail.status, 'queued');
  const raw = await mailToken(account.email, 'verification');
  const record = await ctx.db.collection('accountTokens').findOne({ tokenHash: hashToken(raw) });
  assert.ok(record);
  assert.equal(record.kind, 'verification');
  assert.equal(JSON.stringify(record).includes(raw), false);
  assert.equal((await request('POST', '/verify-email', { token: raw })).status, 200);
  assert.equal((await request('GET', '/me', undefined, account.token)).body.user.emailVerified, true);
  assert.equal((await request('POST', '/verify-email', { token: raw })).status, 400);
  assert.equal(await ctx.db.collection('accountTokens').countDocuments({ tokenHash: hashToken(raw) }), 0);
});

test('verification resend is authenticated, throttled and supersedes the previous link', async () => {
  const account = await register(), original = await mailToken(account.email, 'verification');
  assert.equal((await request('POST', '/verification/resend', {})).status, 401);
  assert.equal((await request('POST', '/verification/resend', {}, account.token)).status, 202);
  assert.equal(await ctx.db.collection('emailOutbox').countDocuments({ to: account.email }), 1);
  await ctx.db.collection('users').updateOne({ email: account.email }, { $set: { verificationSentAt: new Date(ctx.now().getTime() - 61000) } });
  assert.equal((await request('POST', '/verification/resend', {}, account.token)).status, 202);
  assert.equal(await ctx.db.collection('emailOutbox').countDocuments({ to: account.email }), 2);
  assert.equal((await request('POST', '/verify-email', { token: original })).status, 400);
  assert.equal((await request('POST', '/verify-email', { token: await mailToken(account.email, 'verification') })).status, 200);
});

test('password recovery is non-enumerating, expires and revokes every session on one-use reset', async () => {
  const account = await register();
  const known = await request('POST', '/forgot-password', { email: account.email });
  const unknown = await request('POST', '/forgot-password', { email: 'missing@example.test' });
  assert.equal(known.status, 202);
  assert.deepEqual(known.body, unknown.body);
  await request('POST', '/forgot-password', { email: account.email });
  assert.equal(await ctx.db.collection('emailOutbox').countDocuments({ to: account.email, kind: 'password-reset' }), 1);
  const raw = await mailToken(account.email, 'reset');
  const login = await request('POST', '/login', { email: account.email, password });
  assert.equal(login.status, 200);
  const resetPassword = 'another very long password 456!';
  assert.equal((await request('POST', '/reset-password', { token: raw, password: 'weak' })).status, 422);
  const userId = new ObjectId(account.user._id);
  const racedSession = token();
  await ctx.db.collection('oauthExchanges').insertOne({ codeHash: hashToken(token()), userId, expiresAt: new Date(Date.now() + 60000) });
  assert.equal((await request('POST', '/reset-password', { token: raw, password: resetPassword })).status, 200);
  // A sign-in already in flight can commit after deleteMany; the old generation must remain invalid.
  await ctx.db.collection('sessions').insertOne({ userId, authVersion: 0, tokenHash: hashToken(racedSession), expiresAt: new Date(Date.now() + 60000), createdAt: new Date() });
  assert.equal((await request('GET', '/me', undefined, racedSession)).status, 401);
  assert.equal((await request('GET', '/me', undefined, account.token)).status, 401);
  assert.equal((await request('GET', '/me', undefined, login.body.token)).status, 401);
  assert.equal(await ctx.db.collection('oauthExchanges').countDocuments({ userId }), 0);
  assert.equal((await request('POST', '/login', { email: account.email, password })).status, 401);
  assert.equal((await request('POST', '/login', { email: account.email, password: resetPassword })).status, 200);
  assert.equal((await request('POST', '/reset-password', { token: raw, password: resetPassword })).status, 400);
  assert.equal(await ctx.db.collection('emailOutbox').countDocuments({ to: account.email, kind: 'password-changed' }), 1);
  const expired = token();
  await ctx.db.collection('accountTokens').insertOne({ tokenHash: hashToken(expired), kind: 'reset', userId, email: account.email, expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await request('POST', '/reset-password', { token: expired, password: resetPassword })).status, 400);
});

test('OAuth state and PKCE are browser bound; exchange is one-use without putting a session token in a URL', async () => {
  ctx.config.githubClientId = 'test-client'; ctx.config.githubClientSecret = 'test-secret';
  providerEmail = `github-${new ObjectId()}@example.test`; providerId++;
  const flow = await start();
  assert.equal(flow.url.origin, 'https://github.com');
  assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(flow.url.searchParams.get('code_challenge')?.length, 43);
  assert.match(flow.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax/);
  const before = providerCalls;
  assert.match((await callback(flow, 'status-pulse-oauth=wrong')).location!, /auth_error=invalid_state/);
  assert.equal(providerCalls, before);
  const finished = await callback(flow);
  assert.equal(finished.status, 303);
  assert.doesNotMatch(finished.location!, /access_token|[?#&]token=/);
  const code = new URLSearchParams(new URL(finished.location!).hash.slice(1)).get('oauth_code');
  assert.ok(code);
  assert.equal(await ctx.db.collection('sessions').countDocuments({ userId: (await ctx.db.collection('users').findOne({ email: providerEmail }))!._id }), 0);
  assert.equal((await request('POST', '/oauth/exchange', { code })).status, 401);
  const exchanged = await request('POST', '/oauth/exchange', { code }, undefined, flow.cookie);
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  assert.equal(exchanged.body.user.emailVerified, true);
  assert.deepEqual(exchanged.body.user.authProviders, ['github']);
  assert.ok(exchanged.body.token);
  assert.equal((await request('POST', '/oauth/exchange', { code }, undefined, flow.cookie)).status, 401);
  assert.match((await callback(flow)).location!, /auth_error=invalid_state/);
  assert.equal((await request('POST', '/login', { email: providerEmail, password })).status, 401);
});

test('provider email cannot take over an existing manual account; authenticated linking enables later provider login', async () => {
  const account = await register();
  providerEmail = account.email; providerId++;
  const attempted = await callback(await start());
  assert.match(attempted.location!, /auth_error=account_exists/);
  assert.equal(await ctx.db.collection('oauthIdentities').countDocuments({ userId: new ObjectId(account.user._id) }), 0);
  assert.equal((await request('POST', '/oauth/github/link', {})).status, 401);
  const link = await start(account.token);
  const linked = await callback(link);
  const code = new URLSearchParams(new URL(linked.location!).hash.slice(1)).get('oauth_code');
  assert.ok(code);
  const exchange = await request('POST', '/oauth/exchange', { code }, undefined, link.cookie);
  assert.equal(exchange.body.user._id, account.user._id);
  assert.deepEqual(exchange.body.user.authProviders, ['password', 'github']);
  assert.equal(exchange.body.user.emailVerified, true);
  const repeat = await start();
  assert.match((await callback(repeat)).location!, /#oauth_code=/);
});

test('provider login requires verified email and provider linking requires a live matching account', async () => {
  providerVerified = false; providerEmail = `unverified-${new ObjectId()}@example.test`; providerId++;
  assert.match((await callback(await start())).location!, /auth_error=email_unverified/);
  assert.equal(await ctx.db.collection('users').countDocuments({ email: providerEmail }), 0);
  providerVerified = true;
  const account = await register();
  const wrongEmail = await start(account.token);
  assert.match((await callback(wrongEmail)).location!, /auth_error=email_mismatch/);
  providerEmail = account.email;
  const expiredSession = await start(account.token);
  await request('POST', '/logout', {}, account.token);
  assert.match((await callback(expiredSession)).location!, /auth_error=link_session_expired/);
});

test('expired OAuth flows and exchanges are rejected even before MongoDB TTL cleanup', async () => {
  const flow = await start();
  await ctx.db.collection('oauthFlows').updateOne({ stateHash: hashToken(flow.state) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.match((await callback(flow)).location!, /auth_error=invalid_state/);
  const code = token(), binding = token();
  await ctx.db.collection('oauthExchanges').insertOne({ codeHash: hashToken(code), browserHash: hashToken(binding), userId: new ObjectId(), expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await request('POST', '/oauth/exchange', { code }, undefined, `status-pulse-oauth=${binding}`)).status, 401);
});

test('a provider-only account can add a password through its verified mailbox without losing provider sign-in', async () => {
  providerEmail = `provider-reset-${new ObjectId()}@example.test`; providerId++;
  const flow = await start(), response = await callback(flow);
  const code = new URLSearchParams(new URL(response.location!).hash.slice(1)).get('oauth_code');
  const account = await request('POST', '/oauth/exchange', { code }, undefined, flow.cookie);
  assert.equal(account.status, 200);
  assert.equal((await request('POST', '/forgot-password', { email: providerEmail })).status, 202);
  const raw = await mailToken(providerEmail, 'reset');
  assert.equal((await request('POST', '/reset-password', { token: raw, password })).status, 200);
  const manual = await request('POST', '/login', { email: providerEmail, password });
  assert.equal(manual.status, 200);
  assert.deepEqual(manual.body.user.authProviders, ['github', 'password']);
  assert.equal(manual.body.user._id, account.body.user._id);
  assert.equal((await request('GET', '/me', undefined, account.body.token)).status, 401);
  assert.match((await callback(await start())).location!, /#oauth_code=/);
});

test('a pending exchange from a previous account generation cannot create a session after password reset', async () => {
  const account = await register(), code = token(), binding = token();
  await ctx.db.collection('users').updateOne({ email: account.email }, { $set: { authVersion: 1 } });
  await ctx.db.collection('oauthExchanges').insertOne({ codeHash: hashToken(code), browserHash: hashToken(binding), authVersion: 0, userId: new ObjectId(account.user._id), expiresAt: new Date(Date.now() + 60000) });
  assert.equal((await request('POST', '/oauth/exchange', { code }, undefined, `status-pulse-oauth=${binding}`)).status, 401);
});

test('development account links cannot verify or reset a real account after email is enabled', async () => {
  const previous = ctx.config.emailMode;
  try {
    ctx.config.emailMode = 'simulation';
    const account = await register();
    const verification = await mailToken(account.email, 'verification');
    await request('POST', '/forgot-password', { email: account.email });
    const reset = await mailToken(account.email, 'reset');
    ctx.config.emailMode = 'resend';
    assert.equal((await request('POST', '/verify-email', { token: verification })).status, 400);
    assert.equal((await request('POST', '/reset-password', { token: reset, password })).status, 400);
    assert.equal((await request('GET', '/me', undefined, account.token)).body.user.emailVerified, false);
    await ctx.db.collection('users').updateOne({ email: account.email }, { $set: { emailVerifiedAt: new Date(), emailVerificationMethod: 'simulation', verificationSentAt: new Date(0) } });
    assert.equal((await request('POST', '/verification/resend', {}, account.token)).status, 202);
    const real = await mailToken(account.email, 'verification');
    assert.notEqual(real, verification);
    assert.equal((await request('POST', '/verify-email', { token: real })).status, 200);
    assert.equal((await request('GET', '/me', undefined, account.token)).body.user.emailVerified, true);
  } finally { ctx.config.emailMode = previous; }
});

test('Google ID tokens require a valid signature, expected audience, nonce, issuer, expiry and verified email', async () => {
  ctx.config.googleClientId = 'google-test-client'; ctx.config.googleClientSecret = 'google-test-secret';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey), keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256' }] });
  const flow = { nonce: token(), verifier: token() };
  async function identity(changes: Record<string, unknown> = {}, signingKey = privateKey) {
    const jwt = await new SignJWT({ nonce: flow.nonce, email: 'google@example.test', email_verified: true, name: 'Google tester', ...changes })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(typeof changes.iss === 'string' ? changes.iss : 'https://accounts.google.com')
      .setAudience(typeof changes.aud === 'string' ? changes.aud : 'google-test-client').setSubject('google-subject').setIssuedAt()
      .setExpirationTime(typeof changes.exp === 'number' ? changes.exp : '5 minutes').sign(signingKey);
    return fetchProviderIdentity(ctx, 'google', flow, 'test-code', { fetch: async () => Response.json({ id_token: jwt }), googleKeys: keys });
  }
  assert.deepEqual(await identity(), { provider: 'google', subject: 'google-subject', email: 'google@example.test', name: 'Google tester' });
  await assert.rejects(identity({ nonce: 'wrong' }));
  await assert.rejects(identity({ aud: 'different-client' }));
  await assert.rejects(identity({ iss: 'https://attacker.example' }));
  await assert.rejects(identity({ exp: Math.floor(Date.now() / 1000) - 60 }));
  await assert.rejects(identity({ email_verified: false }));
  const attacker = await generateKeyPair('RS256');
  await assert.rejects(identity({}, attacker.privateKey));
});

import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { ObjectId, type ClientSession, type Document } from 'mongodb';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { actor, audit, emailSchema, fail, hashToken, HttpError, publicUser, requireUser, sameId, token, transaction, type AppContext } from './core.js';

export type OAuthProvider = 'google' | 'github';
export interface ProviderIdentity { provider: OAuthProvider; subject: string; email: string; name: string }
export interface OAuthDependencies { fetch?: typeof fetch; googleKeys?: JWTVerifyGetKey }
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 10000 });
const providers = z.enum(['google', 'github']);
const opaqueToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export function configuredProviders(ctx: AppContext) {
  return (['google', 'github'] as const).filter(provider => credentials(ctx, provider)).map(id => ({
    id, name: id === 'google' ? 'Google' : 'GitHub', startUrl: `/api/auth/oauth/${id}/start`,
  }));
}
function credentials(ctx: AppContext, provider: OAuthProvider) {
  const clientId = provider === 'google' ? ctx.config.googleClientId : ctx.config.githubClientId;
  const clientSecret = provider === 'google' ? ctx.config.googleClientSecret : ctx.config.githubClientSecret;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
function callbackUrl(ctx: AppContext, provider: OAuthProvider) { return `${ctx.config.publicBaseUrl}/api/auth/oauth/${provider}/callback`; }
function cookieOptions(ctx: AppContext) { return { httpOnly: true, sameSite: 'lax' as const, secure: new URL(ctx.config.publicBaseUrl).protocol === 'https:', path: '/' }; }
function cookieName(ctx: AppContext) { return cookieOptions(ctx).secure ? '__Host-status-pulse-oauth' : 'status-pulse-oauth'; }
function browserBinding(ctx: AppContext, req: Request) {
  const value = (req.get('cookie') ?? '').split(';').map(item => item.trim()).find(item => item.startsWith(`${cookieName(ctx)}=`))?.split('=')[1];
  return value && opaqueToken.safeParse(value).success ? hashToken(value) : '';
}
function finish(ctx: AppContext, res: Response, key: string, value: string) {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.redirect(303, `${ctx.config.publicBaseUrl}/#${new URLSearchParams({ [key]: value })}`);
}

async function beginFlow(ctx: AppContext, provider: OAuthProvider, res: Response, userId?: ObjectId, sessionHash?: string) {
  const config = credentials(ctx, provider);
  if (!config) return fail(503, 'PROVIDER_UNAVAILABLE', 'This sign-in provider has not been configured yet.');
  const state = token(), binding = token(), verifier = token(), nonce = token();
  await ctx.db.collection('oauthFlows').insertOne({ provider, stateHash: hashToken(state), browserHash: hashToken(binding), verifier, nonce,
    ...(userId ? { userId, sessionHash } : {}), createdAt: ctx.now(), expiresAt: new Date(ctx.now().getTime() + 10 * 60_000) });
  res.cookie(cookieName(ctx), binding, { ...cookieOptions(ctx), maxAge: 10 * 60_000 });
  const url = new URL(provider === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: callbackUrl(ctx, provider), state,
    scope: provider === 'google' ? 'openid email profile' : 'read:user user:email', response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    ...(provider === 'google' ? { nonce, prompt: 'select_account' } : {}) }).toString();
  return url.toString();
}

async function providerJson(fetcher: typeof fetch, url: string, init: RequestInit) {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) return fail(502, 'PROVIDER_ERROR', 'The sign-in provider could not complete your request. Please try again.');
  return response.json();
}

/** Identity is taken only from a validated Google ID token or GitHub's authenticated API. */
export async function fetchProviderIdentity(ctx: AppContext, provider: OAuthProvider, flow: Document, code: string, dependencies: OAuthDependencies = {}): Promise<ProviderIdentity> {
  const config = credentials(ctx, provider);
  if (!config) return fail(503, 'PROVIDER_UNAVAILABLE', 'This sign-in provider has not been configured yet.');
  const fetcher = dependencies.fetch ?? fetch;
  const response = await providerJson(fetcher, provider === 'google' ? 'https://oauth2.googleapis.com/token' : 'https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: callbackUrl(ctx, provider),
      grant_type: 'authorization_code', code_verifier: flow.verifier }),
  });
  if (provider === 'google') {
    const parsed = z.object({ id_token: z.string().max(16000) }).safeParse(response);
    if (!parsed.success) return fail(502, 'PROVIDER_ERROR', 'Google did not return a valid sign-in response.');
    const { payload } = await jwtVerify(parsed.data.id_token, dependencies.googleKeys ?? googleKeys, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: config.clientId, algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat', 'nonce', 'email', 'email_verified'], maxTokenAge: '10 minutes', clockTolerance: 5,
    });
    if (payload.nonce !== flow.nonce || (payload.azp && payload.azp !== config.clientId)) return fail(401, 'INVALID_PROVIDER_TOKEN', 'Google sign-in could not be verified.');
    if (payload.email_verified !== true) return fail(403, 'EMAIL_UNVERIFIED', 'Verify your email with Google before signing in.');
    const email = emailSchema.parse(payload.email);
    return { provider, subject: z.string().min(1).max(255).parse(payload.sub), email,
      name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 100) : email.split('@')[0]! };
  }
  const parsed = z.object({ access_token: z.string().min(1).max(4096), token_type: z.string() }).safeParse(response);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== 'bearer') return fail(502, 'PROVIDER_ERROR', 'GitHub did not return a valid sign-in response.');
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${parsed.data.access_token}`, 'user-agent': 'Status-Pulse', 'X-GitHub-Api-Version': '2022-11-28' };
  const [profile, emails] = await Promise.all([
    providerJson(fetcher, 'https://api.github.com/user', { headers }),
    providerJson(fetcher, 'https://api.github.com/user/emails?per_page=100', { headers }),
  ]);
  const identity = z.object({ id: z.number().int().positive().safe(), login: z.string().min(1), name: z.string().nullable().optional() }).parse(profile);
  const addresses = z.array(z.object({ email: emailSchema, verified: z.boolean(), primary: z.boolean() })).parse(emails);
  const address = addresses.find(item => item.verified && item.primary) ?? addresses.find(item => item.verified);
  if (!address) return fail(403, 'EMAIL_UNVERIFIED', 'Add and verify an email address on GitHub before signing in.');
  return { provider, subject: String(identity.id), email: address.email, name: (identity.name?.trim() || identity.login).slice(0, 100) };
}

/** Never merge by email. Linking requires an existing live session and explicit action. */
export async function resolveOAuthUser(ctx: AppContext, identity: ProviderIdentity, session: ClientSession, link?: { userId: ObjectId; sessionHash: string }): Promise<Document> {
  const existingIdentity = await ctx.db.collection('oauthIdentities').findOne({ provider: identity.provider, subject: identity.subject }, { session });
  if (link) {
    const activeSession = await ctx.db.collection('sessions').findOne({ userId: link.userId, tokenHash: link.sessionHash, expiresAt: { $gt: ctx.now() } }, { session });
    if (!activeSession) return fail(401, 'LINK_SESSION_EXPIRED', 'Sign in again before connecting your provider.');
    if (existingIdentity && !sameId(existingIdentity.userId, link.userId)) return fail(409, 'IDENTITY_IN_USE', 'This provider is already connected to another account.');
    const user = await ctx.db.collection('users').findOne({ _id: link.userId }, { session });
    if (!user) return fail(401, 'LINK_SESSION_EXPIRED', 'Sign in again before connecting your provider.');
    if ((activeSession.authVersion ?? 0) !== (user.authVersion ?? 0)) return fail(401, 'LINK_SESSION_EXPIRED', 'Sign in again before connecting your provider.');
    if (user.email !== identity.email) return fail(409, 'EMAIL_MISMATCH', 'Choose the provider account with the same email address as your Status Pulse account.');
    const connected = await ctx.db.collection('oauthIdentities').findOne({ provider: identity.provider, userId: user._id }, { session });
    if (connected && connected.subject !== identity.subject) return fail(409, 'IDENTITY_IN_USE', 'A different account from this provider is already connected.');
    if (!existingIdentity) await ctx.db.collection('oauthIdentities').insertOne({ provider: identity.provider, subject: identity.subject, userId: user._id, createdAt: ctx.now() }, { session });
    const authProviders = [...new Set([...(user.authProviders ?? (user.passwordHash ? ['password'] : [])), identity.provider])];
    await ctx.db.collection('users').updateOne({ _id: user._id }, { $set: { emailVerifiedAt: user.emailVerifiedAt ?? ctx.now(), emailVerificationMethod: 'oauth', authProviders } }, { session });
    await audit(ctx, session, { action: 'account.provider_connected', actorId: user._id, resourceId: user._id, metadata: { provider: identity.provider } });
    return { ...user, emailVerifiedAt: user.emailVerifiedAt ?? ctx.now(), emailVerificationMethod: 'oauth', authProviders };
  }
  if (existingIdentity) {
    const user = await ctx.db.collection('users').findOne({ _id: existingIdentity.userId }, { session });
    if (!user) return fail(401, 'INVALID_PROVIDER_TOKEN', 'This provider account is no longer connected.');
    return user;
  }
  if (await ctx.db.collection('users').findOne({ email: identity.email }, { session })) return fail(409, 'ACCOUNT_EXISTS', 'Sign in to your existing account first, then connect this provider in account settings.');
  const user = { _id: new ObjectId(), name: identity.name, email: identity.email, emailVerifiedAt: ctx.now(), emailVerificationMethod: 'oauth', authProviders: [identity.provider], authVersion: 0, platformRole: 'user', createdAt: ctx.now() };
  await ctx.db.collection('users').insertOne(user, { session });
  await ctx.db.collection('oauthIdentities').insertOne({ provider: identity.provider, subject: identity.subject, userId: user._id, createdAt: ctx.now() }, { session });
  await audit(ctx, session, { action: 'account.registered', actorId: user._id, resourceId: user._id, metadata: { provider: identity.provider } });
  return user;
}

export function oauthRouter(ctx: AppContext, dependencies: OAuthDependencies = {}) {
  const router = Router();
  router.get('/:provider/start', async (req, res) => { res.redirect(303, await beginFlow(ctx, providers.parse(req.params.provider), res)); });
  router.post('/:provider/link', requireUser(ctx), async (req, res) => {
    res.json({ url: await beginFlow(ctx, providers.parse(req.params.provider), res, actor(res)._id, hashToken(req.get('authorization')!.slice(7))) });
  });
  router.get('/:provider/callback', async (req, res) => {
    try {
      const provider = providers.parse(req.params.provider), state = opaqueToken.parse(req.query.state);
      const binding = browserBinding(ctx, req);
      if (!binding) return finish(ctx, res, 'auth_error', 'invalid_state');
      const flow = await ctx.db.collection('oauthFlows').findOneAndDelete({ provider, stateHash: hashToken(state), browserHash: binding, expiresAt: { $gt: ctx.now() } });
      if (!flow) return finish(ctx, res, 'auth_error', 'invalid_state');
      if (req.query.error) return finish(ctx, res, 'auth_error', 'cancelled');
      const identity = await fetchProviderIdentity(ctx, provider, flow, z.string().min(1).max(4096).parse(req.query.code), dependencies);
      const code = token();
      await transaction(ctx, async session => {
        const user = await resolveOAuthUser(ctx, identity, session, flow.userId ? { userId: flow.userId, sessionHash: flow.sessionHash } : undefined);
        await ctx.db.collection('oauthExchanges').insertOne({ codeHash: hashToken(code), browserHash: binding, userId: user._id, authVersion: user.authVersion ?? 0, provider, createdAt: ctx.now(), expiresAt: new Date(ctx.now().getTime() + 60_000) }, { session });
      });
      finish(ctx, res, 'oauth_code', code);
    } catch (error) {
      const allowed = ['ACCOUNT_EXISTS', 'IDENTITY_IN_USE', 'EMAIL_MISMATCH', 'EMAIL_UNVERIFIED', 'LINK_SESSION_EXPIRED'];
      finish(ctx, res, 'auth_error', error instanceof HttpError && allowed.includes(error.code) ? error.code.toLowerCase() : 'sign_in_failed');
    }
  });
  router.post('/exchange', async (req, res) => {
    const { code } = z.object({ code: opaqueToken }).strict().parse(req.body), binding = browserBinding(ctx, req);
    if (!binding) return fail(401, 'INVALID_EXCHANGE', 'This sign-in link is invalid or has expired. Start sign-in again.');
    const bearer = token(), expiresAt = new Date(ctx.now().getTime() + ctx.config.sessionTtlHours * 3600000);
    const user = await transaction(ctx, async session => {
      const exchange = await ctx.db.collection('oauthExchanges').findOneAndDelete({ codeHash: hashToken(code), browserHash: binding, expiresAt: { $gt: ctx.now() } }, { session });
      if (!exchange) return fail(401, 'INVALID_EXCHANGE', 'This sign-in link is invalid or has expired. Start sign-in again.');
      const account = await ctx.db.collection('users').findOne({ _id: exchange.userId }, { session });
      if (!account) return fail(401, 'INVALID_EXCHANGE', 'This sign-in link is invalid or has expired. Start sign-in again.');
      if ((exchange.authVersion ?? 0) !== (account.authVersion ?? 0)) return fail(401, 'INVALID_EXCHANGE', 'This sign-in link is invalid or has expired. Start sign-in again.');
      await ctx.db.collection('sessions').insertOne({ userId: account._id, authVersion: account.authVersion ?? 0, tokenHash: hashToken(bearer), expiresAt, createdAt: ctx.now() }, { session });
      await audit(ctx, session, { action: 'account.logged_in', actorId: account._id, resourceId: account._id, metadata: { provider: exchange.provider } });
      return account;
    });
    res.clearCookie(cookieName(ctx), cookieOptions(ctx));
    res.json({ user: publicUser(user), token: bearer, expiresAt });
  });
  return router;
}

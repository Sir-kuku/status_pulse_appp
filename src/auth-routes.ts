import { Router } from 'express';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { ObjectId, type ClientSession, type Document } from 'mongodb';
import { z } from 'zod';
import { actor, audit, emailSchema, fail, hashToken, nameSchema, publicUser, requireUser, token, transaction, type AppContext } from './core.js';
import { emailContent, emailMode, queueEmail, requireEmailDelivery } from './email.js';
import { configuredProviders, oauthRouter, type OAuthDependencies } from './oauth.js';

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
  return `scrypt$32768$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: unknown): Promise<boolean> {
  if (typeof stored !== 'string') return false;
  const [algorithm, cost, salt, encoded] = stored.split('$');
  if (algorithm !== 'scrypt' || cost !== '32768' || !salt || !encoded || !/^[a-f0-9]{128}$/.test(encoded)) return false;
  const key = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
  return timingSafeEqual(key, Buffer.from(encoded, 'hex'));
}
const passwordSchema = z.string().min(15, 'Use at least 15 characters.').max(128);
const registration = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema }).strict();
const login = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();
const accountTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'This link is invalid. Please request a new one.');
const resetMessage = 'If an account uses this email, you will receive instructions to reset its password.';

async function sendAccountToken(ctx: AppContext, session: ClientSession, user: Document, kind: 'verification' | 'reset') {
  const rawToken = token(), expiresAt = new Date(ctx.now().getTime() + (kind === 'verification' ? 24 : 1) * 3600000);
  await ctx.db.collection('accountTokens').deleteMany({ userId: user._id, kind }, { session });
  await ctx.db.collection('accountTokens').insertOne({ userId: user._id, email: user.email, kind, tokenHash: hashToken(rawToken), simulation: emailMode(ctx) === 'simulation', createdAt: ctx.now(), expiresAt }, { session });
  const verification = kind === 'verification';
  const url = `${ctx.config.publicBaseUrl}/#${verification ? 'verify_email' : 'reset_password'}=${rawToken}`;
  await queueEmail(ctx, session, { kind: verification ? 'account-verification' : 'password-reset', to: user.email, userId: user._id, accountTokenHash: hashToken(rawToken),
    subject: verification ? 'Verify your Status Pulse email' : 'Reset your Status Pulse password',
    ...emailContent(verification ? 'Welcome to Status Pulse' : 'Reset your password', [
      `Hi ${user.name},`, verification ? 'Confirm your email address to keep your Status Pulse account secure.' : 'We received a request to reset your Status Pulse password.',
      verification ? 'This link expires in 24 hours and can only be used once. If you did not create this account, you can ignore this email.'
        : 'This link expires in one hour and can only be used once. If you did not make this request, you can ignore this email. Your current password will keep working.',
    ], { label: verification ? 'Verify email address' : 'Choose a new password', url }),
    dedupeKey: `account:${kind}:${hashToken(rawToken)}`, expiresAt });
  await ctx.db.collection('users').updateOne({ _id: user._id }, { $set: { [verification ? 'verificationSentAt' : 'passwordResetSentAt']: ctx.now() } }, { session });
}

export function authRouter(ctx: AppContext, oauthDependencies: OAuthDependencies = {}): Router {
  const router = Router();
  router.get('/options', (_req, res) => {
    const mode = emailMode(ctx);
    res.json({ providers: configuredProviders(ctx), email: { enabled: mode !== 'disabled', mode },
      branding: { creatorName: ctx.config.creatorName, creatorUrl: ctx.config.creatorUrl ?? null }, simulations: ctx.config.simulations });
  });
  router.use('/oauth', oauthRouter(ctx, oauthDependencies));
  router.post('/register', async (req, res) => {
    const input = registration.parse(req.body);
    const user = { _id: new ObjectId(), name: input.name, email: input.email, passwordHash: await hashPassword(input.password), authProviders: ['password'], authVersion: 0, platformRole: 'user', createdAt: ctx.now() };
    const bearer = token();
    const expiresAt = new Date(ctx.now().getTime() + ctx.config.sessionTtlHours * 3600000);
    await transaction(ctx, async session => {
      await ctx.db.collection('users').insertOne(user, { session });
      await ctx.db.collection('sessions').insertOne({ userId: user._id, authVersion: user.authVersion, tokenHash: hashToken(bearer), expiresAt, createdAt: ctx.now() }, { session });
      await audit(ctx, session, { action: 'account.registered', actorId: user._id, resourceId: user._id });
      if (emailMode(ctx) !== 'disabled') await sendAccountToken(ctx, session, user, 'verification');
    });
    res.status(201).json({ user: publicUser(user), token: bearer, expiresAt,
      verificationEmail: { status: emailMode(ctx) === 'disabled' ? 'unavailable' : 'queued', simulation: emailMode(ctx) === 'simulation' } });
  });
  router.post('/login', async (req, res) => {
    const input = login.parse(req.body);
    const user = await ctx.db.collection('users').findOne({ email: input.email });
    if (!user || typeof user.passwordHash !== 'string') {
      // Equal-cost work avoids the obvious fast "unknown email" path.
      await hashPassword(input.password);
      return fail(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    if (!await verifyPassword(input.password, user.passwordHash)) return fail(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    const bearer = token();
    const expiresAt = new Date(ctx.now().getTime() + ctx.config.sessionTtlHours * 3600000);
    await transaction(ctx, async session => {
      await ctx.db.collection('sessions').insertOne({ userId: user._id, authVersion: user.authVersion ?? 0, tokenHash: hashToken(bearer), expiresAt, createdAt: ctx.now() }, { session });
      await audit(ctx, session, { action: 'account.logged_in', actorId: user._id, resourceId: user._id });
    });
    res.json({ user: publicUser(user), token: bearer, expiresAt });
  });
  router.post('/verification/resend', requireUser(ctx), async (_req, res) => {
    requireEmailDelivery(ctx);
    await transaction(ctx, async session => {
      const user = await ctx.db.collection('users').findOneAndUpdate({ _id: actor(res)._id, $and: [
        { $or: [{ emailVerifiedAt: { $exists: false } }, { emailVerificationMethod: 'simulation' }] },
        { $or: [{ verificationSentAt: { $exists: false } }, { verificationSentAt: { $lte: new Date(ctx.now().getTime() - 60_000) } }] },
      ] },
      { $set: { verificationSentAt: ctx.now() } }, { session, returnDocument: 'after' });
      if (user) await sendAccountToken(ctx, session, user, 'verification');
    });
    res.status(202).json({ message: 'If your email still needs verification, check your inbox. Please allow a minute before requesting another email.' });
  });
  router.post('/verify-email', async (req, res) => {
    const input = z.object({ token: accountTokenSchema }).strict().parse(req.body);
    await transaction(ctx, async session => {
      const record = await ctx.db.collection('accountTokens').findOneAndDelete({ tokenHash: hashToken(input.token), kind: 'verification', expiresAt: { $gt: ctx.now() } }, { session });
      if (!record) return fail(400, 'INVALID_ACCOUNT_TOKEN', 'This verification link is invalid or expired. Request another email from account settings.');
      if (record.simulation && emailMode(ctx) !== 'simulation') return fail(400, 'INVALID_ACCOUNT_TOKEN', 'This development link cannot verify a real email address. Request a new email.');
      const result = await ctx.db.collection('users').updateOne({ _id: record.userId, email: record.email }, { $set: { emailVerifiedAt: ctx.now(), emailVerificationMethod: record.simulation ? 'simulation' : 'email' } }, { session });
      if (!result.matchedCount) return fail(400, 'INVALID_ACCOUNT_TOKEN', 'This verification link is no longer valid.');
      await audit(ctx, session, { action: 'account.email_verified', actorId: record.userId, resourceId: record.userId });
    });
    res.json({ message: 'Your email is verified. You can return to your workspace.' });
  });
  router.post('/forgot-password', async (req, res) => {
    const input = z.object({ email: emailSchema }).strict().parse(req.body);
    requireEmailDelivery(ctx);
    await transaction(ctx, async session => {
      const user = await ctx.db.collection('users').findOneAndUpdate({ email: input.email,
        $or: [{ passwordResetSentAt: { $exists: false } }, { passwordResetSentAt: { $lte: new Date(ctx.now().getTime() - 60_000) } }] },
      { $set: { passwordResetSentAt: ctx.now() } }, { session, returnDocument: 'after' });
      if (user) await sendAccountToken(ctx, session, user, 'reset');
    });
    res.status(202).json({ message: resetMessage });
  });
  router.post('/reset-password', async (req, res) => {
    const input = z.object({ token: accountTokenSchema, password: passwordSchema }).strict().parse(req.body);
    const passwordHash = await hashPassword(input.password);
    await transaction(ctx, async session => {
      const record = await ctx.db.collection('accountTokens').findOneAndDelete({ tokenHash: hashToken(input.token), kind: 'reset', expiresAt: { $gt: ctx.now() } }, { session });
      if (!record) return fail(400, 'INVALID_ACCOUNT_TOKEN', 'This reset link is invalid or expired. Request a new password reset email.');
      if (record.simulation && emailMode(ctx) !== 'simulation') return fail(400, 'INVALID_ACCOUNT_TOKEN', 'This development link cannot reset a live account. Request a new email.');
      const user = await ctx.db.collection('users').findOneAndUpdate({ _id: record.userId, email: record.email },
        { $set: { passwordHash, emailVerifiedAt: ctx.now(), emailVerificationMethod: record.simulation ? 'simulation' : 'email', passwordChangedAt: ctx.now() }, $inc: { authVersion: 1 }, $addToSet: { authProviders: 'password' } }, { session, returnDocument: 'after' });
      if (!user) return fail(400, 'INVALID_ACCOUNT_TOKEN', 'This reset link is no longer valid.');
      await ctx.db.collection('sessions').deleteMany({ userId: record.userId }, { session });
      await ctx.db.collection('oauthExchanges').deleteMany({ userId: record.userId }, { session });
      await ctx.db.collection('oauthFlows').deleteMany({ userId: record.userId }, { session });
      await ctx.db.collection('accountTokens').deleteMany({ userId: record.userId }, { session });
      await audit(ctx, session, { action: 'account.password_reset', actorId: record.userId, resourceId: record.userId });
      if (emailMode(ctx) !== 'disabled') await queueEmail(ctx, session, { kind: 'password-changed', to: user.email, userId: user._id,
        subject: 'Your Status Pulse password has changed', ...emailContent('Your password has changed', [`Hi ${user.name},`, 'Your Status Pulse password was changed and all active sessions were signed out.',
          'If you did not make this change, reset your password immediately from the sign-in page.'], { label: 'Open Status Pulse', url: `${ctx.config.publicBaseUrl}/` }), dedupeKey: `account:password-changed:${hashToken(input.token)}` });
    });
    res.json({ message: 'Your password has been updated. Sign in with your new password.' });
  });
  router.get('/me', requireUser(ctx), (_req, res) => { res.json({ user: actor(res) }); });
  router.post('/logout', requireUser(ctx), async (req, res) => {
    await ctx.db.collection('sessions').deleteOne({ tokenHash: hashToken(req.get('authorization')!.slice(7)) });
    res.status(204).end();
  });
  return router;
}

import { Router } from 'express';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { actor, audit, emailSchema, fail, hashToken, nameSchema, publicUser, requireUser, token, transaction, type AppContext } from './core.js';

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
  return `scrypt$32768$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, cost, salt, encoded] = stored.split('$');
  if (algorithm !== 'scrypt' || cost !== '32768' || !salt || !encoded || !/^[a-f0-9]{128}$/.test(encoded)) return false;
  const key = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
  return timingSafeEqual(key, Buffer.from(encoded, 'hex'));
}
const passwordSchema = z.string().min(15, 'Use at least 15 characters.').max(128);
const registration = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema }).strict();
const login = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();

export function authRouter(ctx: AppContext): Router {
  const router = Router();
  router.post('/register', async (req, res) => {
    const input = registration.parse(req.body);
    const user = { _id: new ObjectId(), name: input.name, email: input.email, passwordHash: await hashPassword(input.password), platformRole: 'user', createdAt: ctx.now() };
    const bearer = token();
    const expiresAt = new Date(ctx.now().getTime() + ctx.config.sessionTtlHours * 3600000);
    await transaction(ctx, async session => {
      await ctx.db.collection('users').insertOne(user, { session });
      await ctx.db.collection('sessions').insertOne({ userId: user._id, tokenHash: hashToken(bearer), expiresAt, createdAt: ctx.now() }, { session });
      await audit(ctx, session, { action: 'account.registered', actorId: user._id, resourceId: user._id });
    });
    res.status(201).json({ user: publicUser(user), token: bearer, expiresAt });
  });
  router.post('/login', async (req, res) => {
    const input = login.parse(req.body);
    const user = await ctx.db.collection('users').findOne({ email: input.email });
    if (!user) {
      // Equal-cost work avoids the obvious fast "unknown email" path.
      await hashPassword(input.password);
      return fail(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    if (!await verifyPassword(input.password, user.passwordHash)) return fail(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    const bearer = token();
    const expiresAt = new Date(ctx.now().getTime() + ctx.config.sessionTtlHours * 3600000);
    await transaction(ctx, async session => {
      await ctx.db.collection('sessions').insertOne({ userId: user._id, tokenHash: hashToken(bearer), expiresAt, createdAt: ctx.now() }, { session });
      await audit(ctx, session, { action: 'account.logged_in', actorId: user._id, resourceId: user._id });
    });
    res.json({ user: publicUser(user), token: bearer, expiresAt });
  });
  router.get('/me', requireUser(ctx), (_req, res) => { res.json({ user: actor(res) }); });
  router.post('/logout', requireUser(ctx), async (req, res) => {
    await ctx.db.collection('sessions').deleteOne({ tokenHash: hashToken(req.get('authorization')!.slice(7)) });
    res.status(204).end();
  });
  return router;
}

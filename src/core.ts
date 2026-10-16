import { randomBytes, createHash } from 'node:crypto';
import { MongoClient, ObjectId, type Db, type ClientSession, type Document } from 'mongodb';
import type { Request, Response, RequestHandler } from 'express';
import { z } from 'zod';

export interface Config {
  env: string; port: number; mongoUri: string; database: string; publicBaseUrl: string;
  workerConcurrency: number; workerPollMs: number; sessionTtlHours: number; simulations: boolean;
}
export interface AppContext { client: MongoClient; db: Db; config: Config; now: () => Date }
export type Role = 'owner' | 'responder' | 'viewer';
export type ServiceStatus = 'operational' | 'degraded' | 'outage' | 'unknown';
export interface Principal { _id: ObjectId; email: string; name: string; platformRole: 'user' | 'admin' }
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const fail = (status: number, code: string, message: string): never => { throw new HttpError(status, code, message); };
export function oid(value: unknown): ObjectId {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) return fail(400, 'INVALID_ID', 'Expected a 24-character resource ID.');
  return new ObjectId(value);
}
export const sameId = (a: ObjectId | undefined | null, b: ObjectId | undefined | null) => Boolean(a && b && a.equals(b));
export const token = () => randomBytes(32).toString('base64url');
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const nameSchema = z.string().trim().min(1).max(100);
export const idSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Expected a resource ID');
export function actor(res: Response): Principal { return res.locals.user as Principal; }
export function publicUser(user: Document): Principal {
  return { _id: user._id, email: user.email, name: user.name, platformRole: user.platformRole };
}
export async function transaction<T>(ctx: AppContext, work: (session: ClientSession) => Promise<T>): Promise<T> {
  return ctx.client.withSession(async session => {
    const result = await session.withTransaction(() => work(session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000,
    });
    return result as T;
  });
}
export async function audit(ctx: AppContext, session: ClientSession | undefined, event: {
  action: string; actorId?: ObjectId | null; projectId?: ObjectId; resourceId?: ObjectId;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await ctx.db.collection('auditEvents').insertOne({ ...event, actorId: event.actorId ?? null, createdAt: ctx.now() }, { session });
}
export function requireUser(ctx: AppContext): RequestHandler {
  return async (req, res, next) => {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer ') || header.length > 512) return next(new HttpError(401, 'UNAUTHENTICATED', 'A valid bearer token is required.'));
    const session = await ctx.db.collection('sessions').findOne({ tokenHash: hashToken(header.slice(7)), expiresAt: { $gt: ctx.now() } });
    if (!session) return next(new HttpError(401, 'UNAUTHENTICATED', 'Session is invalid or expired.'));
    const user = await ctx.db.collection('users').findOne({ _id: session.userId });
    if (!user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Session is invalid or expired.'));
    res.locals.user = publicUser(user);
    next();
  };
}
export async function projectAccess(ctx: AppContext, req: Request, res: Response, roles: Role[] = ['owner', 'responder', 'viewer']): Promise<Document> {
  const projectId = oid(req.params.projectId);
  const membership = await ctx.db.collection('memberships').findOne({ projectId, userId: actor(res)._id });
  if (!membership) return fail(404, 'NOT_FOUND', 'Project not found.');
  if (!roles.includes(membership.role)) return fail(403, 'FORBIDDEN', 'Your project role does not allow this action.');
  const project = await ctx.db.collection('projects').findOne({ _id: projectId, archivedAt: { $exists: false } });
  if (!project) return fail(404, 'NOT_FOUND', 'Project not found.');
  return project;
}
export async function serviceInProject(ctx: AppContext, req: Request): Promise<Document> {
  const service = await ctx.db.collection('services').findOne({ _id: oid(req.params.serviceId), projectId: oid(req.params.projectId), archivedAt: { $exists: false } });
  if (!service) return fail(404, 'NOT_FOUND', 'Service not found.');
  return service;
}
export function pagination(req: Request) {
  return z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(10000).default(0) }).parse(req.query);
}
export function effectiveStatus(service: Document, now: Date): ServiceStatus {
  if (!service.enabled || service.archivedAt) return 'unknown';
  if (service.override && new Date(service.override.expiresAt) > now) return service.override.status;
  if (!service.enabled || !service.lastCheckedAt || now.getTime() - new Date(service.lastCheckedAt).getTime() > service.intervalSeconds * 3000) return 'unknown';
  return service.calculatedStatus ?? 'unknown';
}

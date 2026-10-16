import { Router } from 'express';
import { ObjectId, type ClientSession, type Document } from 'mongodb';
import { z } from 'zod';
import { type AppContext, effectiveStatus, emailSchema, fail, hashToken, idSchema, oid, token, transaction } from './core.js';

const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict();
const signupSchema = z.object({ email: emailSchema, serviceIds: z.array(idSchema).min(1).max(50).refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length, 'Select each service only once.') }).strict();
const verifySchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

const publicIncident = (incident: Document) => ({ _id: incident._id, serviceId: incident.serviceId, title: incident.title, state: incident.state, createdAt: incident.createdAt, updatedAt: incident.updatedAt });
const publicUpdate = (update: Document) => ({ _id: update._id, message: update.message, state: update.state, createdAt: update.createdAt });

async function publicProject(ctx: AppContext, slug: unknown, session?: ClientSession): Promise<Document> {
  const parsed = z.string().min(1).max(100).parse(slug);
  const project = await ctx.db.collection('projects').findOne({ slug: parsed, publicEnabled: true, archivedAt: { $exists: false } }, { session });
  if (!project) return fail(404, 'NOT_FOUND', 'Public project not found.');
  return project;
}
async function visibleServiceIds(ctx: AppContext, projectId: ObjectId): Promise<ObjectId[]> {
  const services = await ctx.db.collection('services').find({ projectId, publicVisible: true, archivedAt: { $exists: false } }, { projection: { _id: 1 } }).toArray();
  return services.map(service => service._id);
}

export function publicRouter(ctx: AppContext): Router {
  const router = Router();
  router.get('/projects/:slug', async (req, res) => {
    const project = await publicProject(ctx, req.params.slug);
    const { limit, offset } = listSchema.parse(req.query);
    const allServices = await ctx.db.collection('services').find({ projectId: project._id, publicVisible: true, archivedAt: { $exists: false } }).sort({ name: 1, _id: 1 }).toArray();
    const statuses = allServices.map(service => effectiveStatus(service, ctx.now()));
    const status = statuses.includes('outage') ? 'outage' : statuses.includes('degraded') ? 'degraded' : !statuses.length || statuses.includes('unknown') ? 'unknown' : 'operational';
    const services = allServices.slice(offset, offset + limit).map(service => ({ _id: service._id, name: service.name,
      status: effectiveStatus(service, ctx.now()), lastCheckedAt: service.lastCheckedAt ?? null }));
    res.json({ project: { name: project.name, slug: project.slug, status }, services, total: allServices.length, limit, offset });
  });
  router.get('/projects/:slug/services/:serviceId/history', async (req, res) => {
    const project = await publicProject(ctx, req.params.slug);
    const service = await ctx.db.collection('services').findOne({ _id: oid(req.params.serviceId), projectId: project._id, publicVisible: true, archivedAt: { $exists: false } });
    if (!service) return fail(404, 'NOT_FOUND', 'Public service not found.');
    const { limit, offset } = listSchema.parse(req.query);
    const records = await ctx.db.collection('statusHistory').find({ serviceId: service._id, projectId: project._id }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray();
    // Internal reasons can contain operator notes. Only state and time are public.
    const items = records.map(record => ({ _id: record._id, from: record.from, to: record.to, createdAt: record.createdAt }));
    res.json({ service: { _id: service._id, name: service.name }, items, limit, offset });
  });
  router.get('/projects/:slug/incidents', async (req, res) => {
    const project = await publicProject(ctx, req.params.slug);
    const { limit, offset } = listSchema.parse(req.query);
    const serviceIds = await visibleServiceIds(ctx, project._id);
    const records = await ctx.db.collection('incidents').find({ projectId: project._id, serviceId: { $in: serviceIds }, publicVisible: true }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray();
    res.json({ items: records.map(publicIncident), limit, offset });
  });
  router.get('/projects/:slug/incidents/:incidentId', async (req, res) => {
    const project = await publicProject(ctx, req.params.slug);
    const { limit, offset } = listSchema.parse(req.query);
    const serviceIds = await visibleServiceIds(ctx, project._id);
    const incident = await ctx.db.collection('incidents').findOne({ _id: oid(req.params.incidentId), projectId: project._id, serviceId: { $in: serviceIds }, publicVisible: true });
    if (!incident) return fail(404, 'NOT_FOUND', 'Public incident not found.');
    const updates = await ctx.db.collection('incidentUpdates').find({ incidentId: incident._id, projectId: project._id, serviceId: incident.serviceId, publicVisible: true }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray();
    res.json({ incident: publicIncident(incident), updates: updates.map(publicUpdate), limit, offset });
  });
  router.post('/projects/:slug/subscriptions', async (req, res) => {
    const body = signupSchema.parse(req.body);
    if (!ctx.config.simulations) return fail(503, 'EMAIL_UNAVAILABLE', 'A verification email provider is not configured.');
    const serviceIds = body.serviceIds.map(oid);
    const createSubscription = async (session: ClientSession) => {
      const project = await publicProject(ctx, req.params.slug, session);
      const visibleCount = await ctx.db.collection('services').countDocuments({ _id: { $in: serviceIds }, projectId: project._id, publicVisible: true, archivedAt: { $exists: false } }, { session });
      if (visibleCount !== serviceIds.length) return fail(400, 'INVALID_SERVICES', 'Choose only services listed on this public status page.');
      const existing = await ctx.db.collection('subscriptions').findOne({ projectId: project._id, email: body.email }, { session });
      if (existing && (existing.verifiedAt || !existing.verificationExpiresAt || new Date(existing.verificationExpiresAt) > ctx.now())) return null;
      const verificationToken = token();
      const createdAt = ctx.now();
      const verificationExpiresAt = new Date(createdAt.getTime() + 24 * 3600000);
      const subscription = { _id: existing?._id ?? new ObjectId(), projectId: project._id, email: body.email, serviceIds,
        verificationTokenHash: hashToken(verificationToken), verificationExpiresAt, createdAt };
      if (existing) {
        await ctx.db.collection('subscriptions').updateOne({ _id: existing._id }, {
          $set: { serviceIds, verificationTokenHash: subscription.verificationTokenHash, verificationExpiresAt, renewedAt: createdAt },
        }, { session });
        await ctx.db.collection('simulatedMail').deleteMany({ subscriptionId: existing._id, kind: 'subscription-verification' }, { session });
      } else await ctx.db.collection('subscriptions').insertOne(subscription, { session });
      await ctx.db.collection('simulatedMail').insertOne({ projectId: project._id, subscriptionId: subscription._id, recipient: body.email,
        kind: 'subscription-verification', token: verificationToken, expiresAt: verificationExpiresAt, createdAt, simulation: true }, { session });
      return { verificationToken, expiresAt: verificationExpiresAt };
    };
    let result;
    try { result = await transaction(ctx, createSubscription); }
    catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      result = await transaction(ctx, createSubscription);
    }
    res.status(202).json({ accepted: true, simulation: true, message: 'Verification was queued in the simulated inbox. No real email was sent.',
      ...(result && ctx.config.env !== 'production' ? { simulatedEmail: result, notice: 'Development simulation only; this does not prove ownership of a real mailbox.' } : {}) });
  });
  router.post('/subscriptions/verify', async (req, res) => {
    const body = verifySchema.parse(req.body);
    if (!ctx.config.simulations) return fail(409, 'SIMULATIONS_DISABLED', 'Simulated verification is disabled.');
    await transaction(ctx, async session => {
      const subscription = await ctx.db.collection('subscriptions').findOne({ verificationTokenHash: hashToken(body.token), verificationExpiresAt: { $gt: ctx.now() }, verifiedAt: { $exists: false } }, { session });
      if (!subscription) return fail(400, 'INVALID_VERIFICATION', 'Verification link is invalid or expired.');
      const project = await ctx.db.collection('projects').findOne({ _id: subscription.projectId, publicEnabled: true, archivedAt: { $exists: false } }, { session });
      const visibleCount = await ctx.db.collection('services').countDocuments({ _id: { $in: subscription.serviceIds }, projectId: subscription.projectId, publicVisible: true, archivedAt: { $exists: false } }, { session });
      if (!project || visibleCount !== subscription.serviceIds.length) return fail(409, 'SUBSCRIPTION_UNAVAILABLE', 'The selected public subscription is no longer available.');
      await ctx.db.collection('subscriptions').updateOne({ _id: subscription._id }, {
        $set: { verifiedAt: ctx.now(), verificationMethod: 'simulation' }, $unset: { verificationTokenHash: '', verificationExpiresAt: '' },
      }, { session });
      await ctx.db.collection('simulatedMail').deleteMany({ subscriptionId: subscription._id, kind: 'subscription-verification' }, { session });
    });
    res.json({ verified: true, simulation: true, message: 'Simulated verification completed; no real mailbox ownership was verified.' });
  });
  return router;
}

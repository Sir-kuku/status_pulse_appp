import { Router } from 'express';
import { ObjectId, type ClientSession } from 'mongodb';
import { z } from 'zod';
import { type AppContext, actor, audit, fail, oid, projectAccess, requireUser, serviceInProject, transaction } from './core.js';
import { deliverPendingAlerts, notifyPublicIncidentUpdate } from './delivery.js';

const states = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
const messageSchema = z.string().trim().min(1).max(5000);
const createSchema = z.object({ title: z.string().trim().min(3).max(200), message: messageSchema, publicVisible: z.boolean().default(false) }).strict();
const updateSchema = z.object({ version: z.number().int().min(1), message: messageSchema, state: z.enum(states).optional(), publicVisible: z.boolean().optional() }).strict();
const paymentSchema = z.object({ idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/), plan: z.literal('advanced'), simulateFailure: z.boolean().default(false) }).strict();

function paginationStrict(query: unknown) {
  return z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict().parse(query);
}

export function incidentRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(requireUser(ctx));

  router.get('/:projectId/incidents', async (req, res) => {
    const project = await projectAccess(ctx, req, res);
    const { limit, offset } = paginationStrict(req.query);
    const items = await ctx.db.collection('incidents').find({ projectId: project._id }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray();
    res.json({ items, limit, offset });
  });
  router.get('/:projectId/services/:serviceId/incidents', async (req, res) => {
    await projectAccess(ctx, req, res);
    const service = await serviceInProject(ctx, req);
    const { limit, offset } = paginationStrict(req.query);
    const items = await ctx.db.collection('incidents').find({ projectId: service.projectId, serviceId: service._id }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray();
    res.json({ items, limit, offset });
  });
  router.get('/:projectId/incidents/:incidentId', async (req, res) => {
    const project = await projectAccess(ctx, req, res);
    const incident = await ctx.db.collection('incidents').findOne({ _id: oid(req.params.incidentId), projectId: project._id });
    if (!incident) return fail(404, 'NOT_FOUND', 'Incident not found.');
    const { limit, offset } = paginationStrict(req.query);
    const updates = await ctx.db.collection('incidentUpdates').find({ incidentId: incident._id, projectId: project._id }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray();
    res.json({ incident, updates, limit, offset });
  });
  router.post('/:projectId/services/:serviceId/incidents', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner', 'responder']);
    const service = await serviceInProject(ctx, req);
    const body = createSchema.parse(req.body);
    const result = await transaction(ctx, async session => {
      const existing = await ctx.db.collection('incidents').findOne({ serviceId: service._id, active: true }, { session });
      if (existing) return fail(409, 'ACTIVE_INCIDENT_EXISTS', 'This service already has an active incident.');
      const createdAt = ctx.now();
      const incident = { _id: new ObjectId(), projectId: project._id, serviceId: service._id, title: body.title,
        state: 'investigating', active: true, publicVisible: body.publicVisible, createdAt, updatedAt: createdAt, createdBy: actor(res)._id, source: 'manual', version: 1 };
      const update = { _id: new ObjectId(), incidentId: incident._id, projectId: project._id, serviceId: service._id,
        message: body.message, state: incident.state, publicVisible: body.publicVisible, createdAt, createdBy: actor(res)._id };
      await ctx.db.collection('incidents').insertOne(incident, { session });
      await ctx.db.collection('incidentUpdates').insertOne(update, { session });
      await ctx.db.collection('alerts').insertOne({ projectId: project._id, serviceId: service._id, incidentId: incident._id,
        dedupeKey: `outage:${incident._id}`, kind: 'outage', deliveryState: 'pending', attempts: 0, createdAt }, { session });
      await notifyPublicIncidentUpdate(ctx, session, update);
      await audit(ctx, session, { action: 'incident.created', actorId: actor(res)._id, projectId: project._id, resourceId: incident._id });
      return { incident, update };
    });
    res.status(201).json(result);
  });
  router.post('/:projectId/incidents/:incidentId/updates', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner', 'responder']);
    const incidentId = oid(req.params.incidentId);
    const body = updateSchema.parse(req.body);
    const result = await transaction(ctx, async session => {
      const incident = await ctx.db.collection('incidents').findOne({ _id: incidentId, projectId: project._id }, { session });
      if (!incident) return fail(404, 'NOT_FOUND', 'Incident not found.');
      if (incident.version !== body.version) return fail(409, 'VERSION_CONFLICT', 'Incident changed; reload its current version.');
      if (!incident.active) return fail(409, 'INCIDENT_RESOLVED', 'A resolved incident cannot be updated.');
      const nextState = body.state ?? incident.state;
      const currentIndex = states.indexOf(incident.state);
      const nextIndex = states.indexOf(nextState);
      if (nextIndex < currentIndex || nextIndex > currentIndex + 1) return fail(409, 'INVALID_TRANSITION', 'Move through investigating, identified, monitoring, and resolved in order.');
      const createdAt = ctx.now();
      const update = { _id: new ObjectId(), incidentId, projectId: project._id, serviceId: incident.serviceId,
        message: body.message, state: nextState, publicVisible: body.publicVisible ?? incident.publicVisible, createdAt, createdBy: actor(res)._id };
      const changed = await ctx.db.collection('incidents').findOneAndUpdate({ _id: incidentId, projectId: project._id, version: body.version }, {
        $set: { state: nextState, active: nextState !== 'resolved', updatedAt: createdAt }, $inc: { version: 1 },
      }, { session, returnDocument: 'after' });
      if (!changed) return fail(409, 'VERSION_CONFLICT', 'Incident changed; reload its current version.');
      await ctx.db.collection('incidentUpdates').insertOne(update, { session });
      await notifyPublicIncidentUpdate(ctx, session, update);
      await audit(ctx, session, { action: 'incident.updated', actorId: actor(res)._id, projectId: project._id, resourceId: incidentId,
        metadata: { from: incident.state, to: nextState, version: changed.version } });
      return { incident: changed, update };
    });
    res.status(201).json(result);
  });

  router.get('/:projectId/alerts', async (req, res) => {
    const project = await projectAccess(ctx, req, res);
    const { limit, offset } = paginationStrict(req.query);
    const items = await ctx.db.collection('alerts').find({ projectId: project._id }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray();
    res.json({ items, limit, offset });
  });
  router.get('/:projectId/alerts/:alertId/attempts', async (req, res) => {
    const project = await projectAccess(ctx, req, res);
    const alert = await ctx.db.collection('alerts').findOne({ _id: oid(req.params.alertId), projectId: project._id });
    if (!alert) return fail(404, 'NOT_FOUND', 'Alert not found.');
    const { limit, offset } = paginationStrict(req.query);
    const items = await ctx.db.collection('alertAttempts').find({ alertId: alert._id }).sort({ attempt: -1 }).skip(offset).limit(limit).toArray();
    res.json({ items, limit, offset });
  });
  router.post('/:projectId/alerts/:alertId/acknowledge', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner', 'responder']);
    z.object({}).strict().parse(req.body ?? {});
    const alertId = oid(req.params.alertId);
    const alert = await transaction(ctx, async session => {
      const current = await ctx.db.collection('alerts').findOne({ _id: alertId, projectId: project._id }, { session });
      if (!current) return fail(404, 'NOT_FOUND', 'Alert not found.');
      if (current.acknowledgedAt) return current;
      const changed = await ctx.db.collection('alerts').findOneAndUpdate({ _id: alertId, acknowledgedAt: { $exists: false } }, {
        $set: { acknowledgedAt: ctx.now(), acknowledgedBy: actor(res)._id },
      }, { session, returnDocument: 'after' });
      await audit(ctx, session, { action: 'alert.acknowledged', actorId: actor(res)._id, projectId: project._id, resourceId: alertId });
      return changed;
    });
    res.json({ alert });
  });
  router.post('/:projectId/alerts/:alertId/retry', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner', 'responder']);
    const body = z.object({ simulateFailure: z.boolean().default(false) }).strict().parse(req.body ?? {});
    if (!ctx.config.simulations) return fail(409, 'SIMULATIONS_DISABLED', 'Simulated delivery is disabled.');
    const alertId = oid(req.params.alertId);
    const alert = await ctx.db.collection('alerts').findOne({ _id: alertId, projectId: project._id });
    if (!alert) return fail(404, 'NOT_FOUND', 'Alert not found.');
    await deliverPendingAlerts(ctx, { alertId, force: true, simulateFailure: body.simulateFailure, limit: 1 });
    res.json({ simulation: true, alert: await ctx.db.collection('alerts').findOne({ _id: alertId, projectId: project._id }) });
  });

  router.get('/:projectId/payments', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner']);
    const { limit, offset } = paginationStrict(req.query);
    const items = await ctx.db.collection('payments').find({ projectId: project._id }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray();
    res.json({ items, limit, offset, simulation: true });
  });
  router.get('/:projectId/simulated-mail', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner']);
    if (!ctx.config.simulations) return fail(409, 'SIMULATIONS_DISABLED', 'Simulated email is disabled.');
    const { limit, offset } = paginationStrict(req.query);
    const items = await ctx.db.collection('simulatedMail').find({ projectId: project._id, expiresAt: { $gt: ctx.now() } }, {
      projection: { _id: 1, kind: 1, recipient: 1, token: 1, expiresAt: 1, createdAt: 1 },
    }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray();
    res.json({ items, limit, offset, simulation: true, message: 'Simulated inbox only. No emails were sent and real mailbox ownership is not verified.' });
  });
  router.post('/:projectId/payments/simulate', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner']);
    const body = paymentSchema.parse(req.body);
    if (!ctx.config.simulations) return fail(409, 'SIMULATIONS_DISABLED', 'Simulated payments are disabled.');
    const savePayment = async (session: ClientSession) => {
      const existing = await ctx.db.collection('payments').findOne({ projectId: project._id, idempotencyKey: body.idempotencyKey }, { session });
      if (existing && existing.plan !== body.plan) return fail(409, 'IDEMPOTENCY_CONFLICT', 'The key was already used for a different payment.');
      if (existing?.state === 'succeeded') return existing;
      const now = ctx.now();
      const state = body.simulateFailure ? 'failed' : 'succeeded';
      const saved = existing
        ? await ctx.db.collection('payments').findOneAndUpdate({ _id: existing._id }, { $set: { state, updatedAt: now }, $inc: { attempts: 1 } }, { session, returnDocument: 'after' })
        : { _id: new ObjectId(), projectId: project._id, idempotencyKey: body.idempotencyKey, plan: body.plan, state, attempts: 1, createdAt: now, updatedAt: now, simulation: true };
      if (!existing && saved) await ctx.db.collection('payments').insertOne(saved, { session });
      if (!saved) return fail(409, 'PAYMENT_CONFLICT', 'Payment changed; retry with the same key.');
      if (state === 'succeeded') {
        const activated = await ctx.db.collection('projects').updateOne({ _id: project._id, archivedAt: { $exists: false }, plan: { $ne: 'advanced' } }, { $set: { plan: 'advanced', planActivatedAt: now } }, { session });
        if (activated.modifiedCount) await audit(ctx, session, { action: 'plan.activated', actorId: actor(res)._id, projectId: project._id, resourceId: saved._id, metadata: { plan: 'advanced', simulation: true } });
      }
      await audit(ctx, session, { action: `payment.${state}`, actorId: actor(res)._id, projectId: project._id, resourceId: saved._id, metadata: { attempt: saved.attempts, simulation: true } });
      return saved;
    };
    // A concurrent first request may win the unique key before this transaction.
    // Re-read the committed result, preserving the same idempotency comparison.
    let payment;
    try { payment = await transaction(ctx, savePayment); }
    catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      payment = await transaction(ctx, savePayment);
    }
    res.json({ payment, simulation: true, message: 'Simulation only. No money was charged.' });
  });
  return router;
}

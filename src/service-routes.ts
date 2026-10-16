import { Router } from 'express';
import { ObjectId, type Document, type ClientSession } from 'mongodb';
import { z } from 'zod';
import { actor, audit, effectiveStatus, fail, nameSchema, pagination, projectAccess, requireUser, serviceInProject, transaction, type AppContext } from './core.js';
import { validateEndpointUrl } from './endpoint-checker.js';
import { enqueueManualCheck } from './monitoring.js';

const fields = {
  name: nameSchema,
  url: z.string().url().max(2048),
  method: z.enum(['GET', 'HEAD']).default('GET'),
  intervalSeconds: z.number().int().refine(v => [30, 60, 120, 300, 600].includes(v), 'Choose 30, 60, 120, 300, or 600 seconds.').default(60),
  timeoutMs: z.number().int().min(500).max(10000).default(5000),
  expectedStatusMin: z.number().int().min(100).max(599).default(200),
  expectedStatusMax: z.number().int().min(100).max(599).default(299),
  slowThresholdMs: z.number().int().min(1).max(10000).default(1000),
  failureThreshold: z.number().int().min(1).max(10).default(3),
  recoveryThreshold: z.number().int().min(1).max(10).default(2),
  enabled: z.boolean().default(true),
  publicVisible: z.boolean().default(false),
};
const serviceInput = z.object(fields).strict();
// Remove create-time defaults before making PATCH properties optional.
const servicePatch = z.object(Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, (schema instanceof z.ZodDefault ? schema.removeDefault() : schema).optional()]))).extend({ version: z.number().int().positive() }).strict();
function checkConfig(input: Document, project: Document) {
  try { validateEndpointUrl(input.url); } catch { return fail(422, 'UNSAFE_ENDPOINT', 'Use a public HTTP(S) URL without credentials or a fragment. Private, local, and reserved addresses are not allowed.'); }
  if (input.expectedStatusMin > input.expectedStatusMax) return fail(422, 'INVALID_STATUS_RANGE', 'Expected status minimum must not exceed maximum.');
  if (input.slowThresholdMs > input.timeoutMs) return fail(422, 'INVALID_THRESHOLD', 'Slow threshold must not exceed the timeout.');
  if (input.intervalSeconds * 1000 <= input.timeoutMs) return fail(422, 'INVALID_TIMEOUT', 'Timeout must be shorter than the check interval.');
  if (input.intervalSeconds < 60 && project.plan !== 'advanced') return fail(422, 'PLAN_LIMIT', 'Thirty-second monitoring requires the advanced plan.');
}
function configOf(service: Document) { return Object.fromEntries(Object.keys(fields).map(key => [key, service[key]])); }
async function recordVersion(ctx: AppContext, session: ClientSession, service: Document, actorId: ObjectId) {
  await ctx.db.collection('serviceVersions').insertOne({ serviceId: service._id, projectId: service.projectId, version: service.configVersion, config: configOf(service), actorId, createdAt: ctx.now() }, { session });
}
function view(service: Document, ctx: AppContext) { return { ...service, status: effectiveStatus(service, ctx.now()) }; }

export function serviceRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(requireUser(ctx));
  router.post('/:projectId/services', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner']);
    const input = serviceInput.parse(req.body);
    checkConfig(input, project);
    const service = { _id: new ObjectId(), projectId: project._id, ...input, configVersion: 1, nextCheckAt: ctx.now(), calculatedStatus: 'unknown', observedStatus: 'unknown', failureStreak: 0, successStreak: 0, createdAt: ctx.now(), updatedAt: ctx.now() };
    await transaction(ctx, async session => {
      await ctx.db.collection('services').insertOne(service, { session });
      await recordVersion(ctx, session, service, actor(res)._id);
      await audit(ctx, session, { action: 'service.created', actorId: actor(res)._id, projectId: project._id, resourceId: service._id, metadata: { version: 1 } });
    });
    res.status(201).json({ service: view(service, ctx) });
  });
  router.get('/:projectId/services', async (req, res) => {
    const project = await projectAccess(ctx, req, res);
    const { limit, offset } = pagination(req);
    const services = await ctx.db.collection('services').find({ projectId: project._id, archivedAt: { $exists: false } }).sort({ _id: -1 }).skip(offset).limit(limit).toArray();
    res.json({ services: services.map(s => view(s, ctx)), limit, offset });
  });
  router.get('/:projectId/services/:serviceId', async (req, res) => {
    await projectAccess(ctx, req, res);
    res.json({ service: view(await serviceInProject(ctx, req), ctx) });
  });
  router.patch('/:projectId/services/:serviceId', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner']);
    const existing = await serviceInProject(ctx, req);
    const { version, ...patch } = servicePatch.parse(req.body);
    const updated = await transaction(ctx, async session => {
      const current = await ctx.db.collection('services').findOne({ _id: existing._id, configVersion: version, archivedAt: { $exists: false } }, { session });
      if (!current) return fail(409, 'VERSION_CONFLICT', 'Service changed. Fetch it and retry using its latest configVersion as version.');
      const config = { ...configOf(current), ...patch };
      checkConfig(config, project);
      const reset = { ...current, ...config, lastCheckedAt: undefined, calculatedStatus: 'unknown' };
      const service = await ctx.db.collection('services').findOneAndUpdate({ _id: current._id, configVersion: version }, {
        $set: { ...config, updatedAt: ctx.now(), nextCheckAt: ctx.now(), calculatedStatus: 'unknown', failureStreak: 0, successStreak: 0, observedStatus: effectiveStatus(reset, ctx.now()) },
        $unset: { lastCheckedAt: '', lastProcessedDueAt: '', lastProcessedJobId: '' }, $inc: { configVersion: 1 },
      }, { session, returnDocument: 'after' });
      if (!service) return fail(409, 'VERSION_CONFLICT', 'Service changed. Fetch it and retry using its latest configVersion as version.');
      await recordVersion(ctx, session, service, actor(res)._id);
      const from = effectiveStatus(current, ctx.now());
      const to = effectiveStatus(service, ctx.now());
      if (from !== to) await ctx.db.collection('statusHistory').insertOne({ serviceId: service._id, projectId: project._id, from, to, reason: 'configuration_changed', createdAt: ctx.now() }, { session });
      await audit(ctx, session, { action: 'service.configuration_changed', actorId: actor(res)._id, projectId: project._id, resourceId: service._id, metadata: { version: service.configVersion, changedFields: Object.keys(patch) } });
      return service;
    });
    res.json({ service: view(updated, ctx) });
  });
  router.delete('/:projectId/services/:serviceId', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner']);
    const service = await serviceInProject(ctx, req);
    await transaction(ctx, async session => {
      await ctx.db.collection('services').updateOne({ _id: service._id }, { $set: { archivedAt: ctx.now(), enabled: false, publicVisible: false, observedStatus: 'unknown' }, $inc: { configVersion: 1 } }, { session });
      await audit(ctx, session, { action: 'service.archived', actorId: actor(res)._id, projectId: project._id, resourceId: service._id });
    });
    res.status(204).end();
  });
  router.get('/:projectId/services/:serviceId/config-versions', async (req, res) => {
    await projectAccess(ctx, req, res, ['owner']);
    const service = await serviceInProject(ctx, req);
    const { limit, offset } = pagination(req);
    res.json({ versions: await ctx.db.collection('serviceVersions').find({ serviceId: service._id }).sort({ version: -1 }).skip(offset).limit(limit).toArray(), limit, offset });
  });
  router.post('/:projectId/services/:serviceId/checks', async (req, res) => {
    await projectAccess(ctx, req, res, ['owner', 'responder']);
    const service = await serviceInProject(ctx, req);
    if (!service.enabled) return fail(409, 'SERVICE_DISABLED', 'Enable the service before requesting a check.');
    const job = await enqueueManualCheck(ctx, service, actor(res)._id);
    res.status(202).json({ job: { _id: job._id, state: job.state, dueAt: job.dueAt } });
  });
  router.get('/:projectId/services/:serviceId/checks', async (req, res) => {
    await projectAccess(ctx, req, res);
    const service = await serviceInProject(ctx, req);
    const { limit, offset } = pagination(req);
    res.json({ results: await ctx.db.collection('checkResults').find({ serviceId: service._id }).sort({ checkedAt: -1, _id: -1 }).skip(offset).limit(limit).toArray(), limit, offset });
  });
  router.get('/:projectId/services/:serviceId/history', async (req, res) => {
    await projectAccess(ctx, req, res);
    const service = await serviceInProject(ctx, req);
    const { limit, offset } = pagination(req);
    res.json({ history: await ctx.db.collection('statusHistory').find({ serviceId: service._id }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray(), limit, offset });
  });
  router.put('/:projectId/services/:serviceId/override', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner', 'responder']);
    const existing = await serviceInProject(ctx, req);
    const input = z.object({ status: z.enum(['operational', 'degraded', 'outage', 'unknown']), reason: z.string().trim().min(5).max(500), expiresAt: z.iso.datetime() }).strict().parse(req.body);
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt <= ctx.now() || expiresAt.getTime() > ctx.now().getTime() + 86400000) return fail(422, 'INVALID_EXPIRY', 'Override expiry must be in the future and within 24 hours.');
    await transaction(ctx, async session => {
      const service = await ctx.db.collection('services').findOne({ _id: existing._id, archivedAt: { $exists: false } }, { session });
      if (!service) return fail(404, 'NOT_FOUND', 'Service not found.');
      const from = effectiveStatus(service, ctx.now());
      const override = { ...input, expiresAt, actorId: actor(res)._id };
      const to = effectiveStatus({ ...service, override }, ctx.now());
      await ctx.db.collection('services').updateOne({ _id: service._id }, { $set: { override, observedStatus: to } }, { session });
      if (from !== to) await ctx.db.collection('statusHistory').insertOne({ serviceId: service._id, projectId: project._id, from, to, reason: 'manual_override', createdAt: ctx.now() }, { session });
      await audit(ctx, session, { action: 'service.override_set', actorId: actor(res)._id, projectId: project._id, resourceId: service._id, metadata: { status: input.status, reason: input.reason, expiresAt } });
    });
    res.json({ service: view(await serviceInProject(ctx, req), ctx) });
  });
  router.delete('/:projectId/services/:serviceId/override', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner', 'responder']);
    const existing = await serviceInProject(ctx, req);
    await transaction(ctx, async session => {
      const service = await ctx.db.collection('services').findOne({ _id: existing._id, archivedAt: { $exists: false } }, { session });
      if (!service) return fail(404, 'NOT_FOUND', 'Service not found.');
      const from = effectiveStatus(service, ctx.now());
      const without = { ...service }; delete without.override;
      const to = effectiveStatus(without, ctx.now());
      await ctx.db.collection('services').updateOne({ _id: service._id }, { $unset: { override: '' }, $set: { observedStatus: to } }, { session });
      if (from !== to) await ctx.db.collection('statusHistory').insertOne({ serviceId: service._id, projectId: project._id, from, to, reason: 'override_cleared', createdAt: ctx.now() }, { session });
      await audit(ctx, session, { action: 'service.override_cleared', actorId: actor(res)._id, projectId: project._id, resourceId: service._id });
    });
    res.status(204).end();
  });
  return router;
}

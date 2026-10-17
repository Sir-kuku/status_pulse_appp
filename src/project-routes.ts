import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { actor, audit, emailSchema, fail, hashToken, nameSchema, oid, pagination, projectAccess, requireUser, sameId, token, transaction, type AppContext } from './core.js';
import { emailContent, emailMode, queueEmail, requireEmailDelivery } from './email.js';

const projectInput = z.object({ name: nameSchema, slug: z.string().min(3).max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), publicEnabled: z.boolean().default(false) }).strict();
const invitationInput = z.object({ email: emailSchema, role: z.enum(['responder', 'viewer']) }).strict();

export function projectRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(requireUser(ctx));
  router.post('/projects', async (req, res) => {
    const input = projectInput.parse(req.body);
    const project = { _id: new ObjectId(), ...input, ownerId: actor(res)._id, plan: 'free', createdAt: ctx.now(), version: 1 };
    await transaction(ctx, async session => {
      await ctx.db.collection('projects').insertOne(project, { session });
      await ctx.db.collection('memberships').insertOne({ projectId: project._id, userId: actor(res)._id, role: 'owner', createdAt: ctx.now() }, { session });
      await audit(ctx, session, { action: 'project.created', actorId: actor(res)._id, projectId: project._id, resourceId: project._id });
    });
    res.status(201).json({ project });
  });
  router.get('/projects', async (req, res) => {
    const { limit, offset } = pagination(req);
    const memberships = await ctx.db.collection('memberships').find({ userId: actor(res)._id }).toArray();
    const projects = await ctx.db.collection('projects').find({ _id: { $in: memberships.map(m => m.projectId) }, archivedAt: { $exists: false } }).sort({ _id: -1 }).skip(offset).limit(limit).toArray();
    res.json({ projects: projects.map(p => ({ ...p, myRole: memberships.find(m => sameId(m.projectId, p._id))?.role })), limit, offset });
  });
  router.get('/projects/:projectId', async (req, res) => { res.json({ project: await projectAccess(ctx, req, res) }); });
  router.patch('/projects/:projectId', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner']);
    const input = z.object({ version: z.number().int().positive(), name: nameSchema.optional(), publicEnabled: z.boolean().optional() }).strict().parse(req.body);
    const { version, ...changes } = input;
    const updated = await transaction(ctx, async session => {
      const result = await ctx.db.collection('projects').findOneAndUpdate({ _id: project._id, version }, { $set: { ...changes, updatedAt: ctx.now() }, $inc: { version: 1 } }, { session, returnDocument: 'after' });
      if (!result) return fail(409, 'VERSION_CONFLICT', 'Project changed. Fetch it and retry with its latest version.');
      await audit(ctx, session, { action: 'project.updated', actorId: actor(res)._id, projectId: project._id, resourceId: project._id, metadata: { changedFields: Object.keys(changes) } });
      return result;
    });
    res.json({ project: updated });
  });
  router.delete('/projects/:projectId', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner']);
    await transaction(ctx, async session => {
      await ctx.db.collection('projects').updateOne({ _id: project._id }, { $set: { archivedAt: ctx.now(), publicEnabled: false }, $inc: { version: 1 } }, { session });
      await ctx.db.collection('services').updateMany({ projectId: project._id }, { $set: { archivedAt: ctx.now(), enabled: false, observedStatus: 'unknown' }, $inc: { configVersion: 1 } }, { session });
      await audit(ctx, session, { action: 'project.archived', actorId: actor(res)._id, projectId: project._id, resourceId: project._id });
    });
    res.status(204).end();
  });
  router.get('/projects/:projectId/members', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner']);
    const { limit, offset } = pagination(req);
    const members = await ctx.db.collection('memberships').aggregate([
      { $match: { projectId: project._id } }, { $sort: { _id: 1 } }, { $skip: offset }, { $limit: limit },
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
      { $project: { projectId: 1, userId: 1, role: 1, name: { $arrayElemAt: ['$user.name', 0] }, email: { $arrayElemAt: ['$user.email', 0] } } },
    ]).toArray();
    res.json({ members, limit, offset });
  });
  router.post('/projects/:projectId/invitations', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner']);
    const input = invitationInput.parse(req.body);
    requireEmailDelivery(ctx);
    const simulation = emailMode(ctx) === 'simulation';
    if (!simulation && !actor(res).emailVerified) return fail(403, 'EMAIL_VERIFICATION_REQUIRED', 'Verify your email address before inviting teammates.');
    const existingUser = await ctx.db.collection('users').findOne({ email: input.email });
    if (existingUser && await ctx.db.collection('memberships').findOne({ projectId: project._id, userId: existingUser._id })) return fail(409, 'ALREADY_MEMBER', 'This person already belongs to your project.');
    const recent = await ctx.db.collection('invitations').findOne({ projectId: project._id, email: input.email, createdAt: { $gt: new Date(ctx.now().getTime() - 60_000) }, expiresAt: { $gt: ctx.now() }, acceptedAt: { $exists: false } });
    if (recent && !simulation) return fail(429, 'INVITATION_RECENTLY_SENT', 'An invitation was just sent to this address. Please wait a minute before sending another.');
    const rawToken = token();
    const invitation = { _id: new ObjectId(), projectId: project._id, ...input, tokenHash: hashToken(rawToken), simulation, createdBy: actor(res)._id, createdAt: ctx.now(), expiresAt: new Date(ctx.now().getTime() + 86400000) };
    await transaction(ctx, async session => {
      // A newly issued invitation supersedes prior unaccepted invitations for this address/project.
      await ctx.db.collection('invitations').updateMany({ projectId: project._id, email: input.email, acceptedAt: { $exists: false } }, { $set: { expiresAt: ctx.now() } }, { session });
      await ctx.db.collection('invitations').insertOne(invitation, { session });
      const link = `${ctx.config.publicBaseUrl}/#invite=${encodeURIComponent(rawToken)}`;
      const content = emailContent(`You're invited to ${project.name}`, [`${actor(res).name} invited you to join ${project.name} on Status Pulse as a ${input.role}.`, 'Sign in or create an account using this email address, then accept your invitation. This link expires in 24 hours.'], { label: 'Accept invitation', url: link }, 'If you were not expecting this invitation, you can safely ignore this email.');
      await queueEmail(ctx, session, { kind: 'project-invitation', to: input.email, subject: `Join ${project.name} on Status Pulse`, ...content, dedupeKey: `invitation:${invitation._id}`, projectId: project._id, invitationId: invitation._id, expiresAt: invitation.expiresAt });
      if (simulation) await ctx.db.collection('simulatedMail').insertOne({ projectId: project._id, recipient: input.email, kind: 'project-invitation', token: rawToken, createdAt: ctx.now(), expiresAt: invitation.expiresAt, simulation: true }, { session });
      await audit(ctx, session, { action: 'membership.invited', actorId: actor(res)._id, projectId: project._id, resourceId: invitation._id, metadata: { role: input.role } });
    });
    res.status(201).json({ invitation: { _id: invitation._id, email: input.email, role: input.role, expiresAt: invitation.expiresAt }, delivery: { state: 'queued', simulation }, ...(simulation ? { simulatedEmail: { token: rawToken, note: 'Simulation only; no email was sent.' } } : {}) });
  });
  router.post('/invitations/accept', async (req, res) => {
    const { token: rawToken } = z.object({ token: z.string().min(20).max(200) }).strict().parse(req.body);
    const membership = await transaction(ctx, async session => {
      const invitation = await ctx.db.collection('invitations').findOne({ tokenHash: hashToken(rawToken), email: actor(res).email, expiresAt: { $gt: ctx.now() }, acceptedAt: { $exists: false } }, { session });
      if (!invitation) return fail(400, 'INVALID_INVITATION', 'Invitation is invalid, expired, already used, or belongs to another account.');
      if ((invitation.simulation ?? true) && emailMode(ctx) !== 'simulation') return fail(400, 'INVALID_INVITATION', 'This development invitation cannot be used here. Ask the project owner to send a new invitation.');
      const project = await ctx.db.collection('projects').findOne({ _id: invitation.projectId, archivedAt: { $exists: false } }, { session });
      if (!project) return fail(404, 'NOT_FOUND', 'Project not found.');
      const existing = await ctx.db.collection('memberships').findOne({ projectId: project._id, userId: actor(res)._id }, { session });
      if (existing) return fail(409, 'ALREADY_MEMBER', 'You already belong to this project.');
      const member = { _id: new ObjectId(), projectId: project._id, userId: actor(res)._id, role: invitation.role, createdAt: ctx.now() };
      await ctx.db.collection('memberships').insertOne(member, { session });
      await ctx.db.collection('invitations').updateOne({ _id: invitation._id }, { $set: { acceptedAt: ctx.now() } }, { session });
      await audit(ctx, session, { action: 'membership.accepted', actorId: actor(res)._id, projectId: project._id, resourceId: member._id, metadata: { role: member.role } });
      return member;
    });
    res.status(201).json({ membership });
  });
  router.patch('/projects/:projectId/members/:userId', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner']);
    const { role } = z.object({ role: z.enum(['responder', 'viewer']) }).strict().parse(req.body);
    const userId = oid(req.params.userId);
    const membership = await transaction(ctx, async session => {
      const member = await ctx.db.collection('memberships').findOneAndUpdate({ projectId: project._id, userId, role: { $ne: 'owner' } }, { $set: { role } }, { session, returnDocument: 'after' });
      if (!member) return fail(404, 'NOT_FOUND', 'Editable membership not found. Owner changes are not supported.');
      await audit(ctx, session, { action: 'membership.role_changed', actorId: actor(res)._id, projectId: project._id, resourceId: member._id, metadata: { role } });
      return member;
    });
    res.json({ membership });
  });
  router.delete('/projects/:projectId/members/:userId', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner']);
    const userId = oid(req.params.userId);
    await transaction(ctx, async session => {
      const member = await ctx.db.collection('memberships').findOneAndDelete({ projectId: project._id, userId, role: { $ne: 'owner' } }, { session });
      if (!member) return fail(404, 'NOT_FOUND', 'Removable membership not found. The owner cannot be removed.');
      await audit(ctx, session, { action: 'membership.removed', actorId: actor(res)._id, projectId: project._id, resourceId: member._id });
    });
    res.status(204).end();
  });
  router.get('/projects/:projectId/audit', async (req, res) => {
    const project = await projectAccess(ctx, req, res, ['owner']);
    const { limit, offset } = pagination(req);
    const events = await ctx.db.collection('auditEvents').find({ projectId: project._id }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray();
    res.json({ events, limit, offset });
  });
  return router;
}

import { ObjectId, type ClientSession, type Document } from 'mongodb';
import { type AppContext, hashToken, token, transaction } from './core.js';
import { deliverPendingEmails, emailContent, emailMode, queueEmail } from './email.js';

const MAX_AUTOMATIC_ATTEMPTS = 3;

/** Uses the durable real-email outbox, or the explicitly enabled development simulation. */
export async function deliverPendingAlerts(ctx: AppContext, options: {
  simulateFailure?: boolean; alertId?: ObjectId; force?: boolean; limit?: number;
} = {}): Promise<number> {
  const mode = emailMode(ctx);
  if (mode === 'disabled') return 0;
  if (mode === 'resend') return queueAndDeliverRealAlerts(ctx, options);
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  let processed = 0;
  const seen: ObjectId[] = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await transaction(ctx, async session => {
      const filter: Document = { deliveryState: { $in: ['pending', 'failed'] }, _id: { $nin: seen } };
      if (options.alertId) filter._id = options.alertId;
      if (!options.force) filter.$and = [
        { $or: [{ attempts: { $exists: false } }, { attempts: { $lt: MAX_AUTOMATIC_ATTEMPTS } }] },
        { $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: ctx.now() } }] },
      ];
      const alert = await ctx.db.collection('alerts').findOne(filter, { session, sort: { createdAt: 1, _id: 1 } });
      if (!alert) return null;
      const createdAt = ctx.now();
      const attempt = (alert.attempts ?? 0) + 1;
      const failed = options.simulateFailure === true;
      const outcome = failed ? 'failed' : 'delivered';
      const changes: Document = { $set: { deliveryState: outcome, attempts: attempt, simulation: true } };
      if (failed) {
        changes.$set.lastError = 'Simulated delivery failure.';
        if (attempt < MAX_AUTOMATIC_ATTEMPTS) {
          changes.$set.nextAttemptAt = new Date(createdAt.getTime() + 1000 * 2 ** attempt);
        } else {
          changes.$set.retryExhaustedAt = createdAt;
          changes.$unset = { nextAttemptAt: '' };
        }
      } else {
        changes.$set.deliveredAt = createdAt;
        changes.$unset = { lastError: '', nextAttemptAt: '', retryExhaustedAt: '' };
      }
      await ctx.db.collection('alerts').updateOne({ _id: alert._id }, changes, { session });
      await ctx.db.collection('alertAttempts').insertOne({ alertId: alert._id, attempt, outcome, createdAt, simulation: true,
        ...(failed ? { reason: 'Simulated delivery failure.' } : {}) }, { session });
      return alert._id;
    });
    if (!result) break;
    processed += 1;
    seen.push(result);
    if (options.alertId) break;
  }
  return processed;
}

async function queueAndDeliverRealAlerts(ctx: AppContext, options: { alertId?: ObjectId; force?: boolean; limit?: number }): Promise<number> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const seen: ObjectId[] = [];
  for (let index = 0; index < limit; index++) {
    const alertId = await transaction(ctx, async session => {
      const filter: Document = { deliveryState: { $in: ['pending', 'failed'] }, emailQueuedAt: { $exists: false },
        _id: options.alertId ?? { $nin: seen }, ...(options.force ? {} : { $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: ctx.now() } }] }) };
      const alert = await ctx.db.collection('alerts').findOne(filter, { session, sort: { createdAt: 1, _id: 1 } });
      if (!alert) return null;
      const project = await ctx.db.collection('projects').findOne({ _id: alert.projectId, archivedAt: { $exists: false } }, { session });
      const incident = await ctx.db.collection('incidents').findOne({ _id: alert.incidentId }, { session });
      if (!project || !incident) {
        await ctx.db.collection('alerts').updateOne({ _id: alert._id }, { $set: { deliveryState: 'cancelled', lastError: 'email_no_longer_applicable' } }, { session });
        return alert._id;
      }
      const members = await ctx.db.collection('memberships').find({ projectId: project._id, role: { $in: ['owner', 'responder'] } }, { session }).toArray();
      const recipients = await ctx.db.collection('users').find({ _id: { $in: members.map(member => member.userId) }, emailVerifiedAt: { $exists: true }, emailVerificationMethod: { $ne: 'simulation' } }, { session }).toArray();
      if (!recipients.length) {
        await ctx.db.collection('alerts').updateOne({ _id: alert._id }, { $set: { deliveryState: 'failed', simulation: false, lastError: 'email_no_verified_recipients', nextAttemptAt: new Date(ctx.now().getTime() + 3600_000) } }, { session });
        return alert._id;
      }
      const content = emailContent(`${project.name} needs attention`, [incident.title, 'An incident has been opened. Review the checks and coordinate the response in your workspace.'], { label: 'Open Status Pulse', url: `${ctx.config.publicBaseUrl}/` });
      for (const recipient of recipients) await queueEmail(ctx, session, { kind: 'monitor-alert', to: recipient.email,
        subject: `Status Pulse alert: ${incident.title}`, ...content, dedupeKey: `alert:${alert._id}:${recipient._id}`,
        projectId: project._id, alertId: alert._id, userId: recipient._id });
      await ctx.db.collection('alerts').updateOne({ _id: alert._id }, { $set: { emailQueuedAt: ctx.now(), deliveryState: 'pending', simulation: false }, $unset: { lastError: '', nextAttemptAt: '' } }, { session });
      return alert._id;
    });
    if (!alertId) break;
    seen.push(alertId);
    if (options.alertId) break;
  }
  return deliverPendingEmails(ctx, { alertId: options.alertId, force: options.force, limit });
}

/** Called in the incident transaction; current visibility is checked before any notification. */
export async function notifyPublicIncidentUpdate(ctx: AppContext, session: ClientSession, update: Document): Promise<number> {
  if (!update.publicVisible) return 0;
  const project = await ctx.db.collection('projects').findOne({ _id: update.projectId, publicEnabled: true, archivedAt: { $exists: false } }, { session });
  if (!project) return 0;
  const service = await ctx.db.collection('services').findOne({ _id: update.serviceId, projectId: project._id, publicVisible: true, archivedAt: { $exists: false } }, { session });
  if (!service) return 0;
  const incident = await ctx.db.collection('incidents').findOne({ _id: update.incidentId, projectId: project._id, serviceId: service._id, publicVisible: true }, { session });
  if (!incident) return 0;
  let count = 0;
  const mode = emailMode(ctx);
  const simulation = mode === 'simulation';
  const subscribers = ctx.db.collection('subscriptions').find({ projectId: project._id, serviceIds: service._id, verifiedAt: { $exists: true }, revokedAt: { $exists: false },
    ...(mode === 'resend' ? { verificationMethod: 'email' } : {}) }, { session });
  for await (const subscriber of subscribers) {
    const notificationId = new ObjectId();
    const unsubscribeToken = token();
    const result = await ctx.db.collection('notifications').updateOne({ subscriptionId: subscriber._id, eventKey: `incident-update:${update._id}` }, {
      $setOnInsert: { _id: notificationId, projectId: project._id, serviceId: service._id, incidentId: incident._id, updateId: update._id,
        type: 'incident_update', createdAt: ctx.now(), deliveryState: simulation ? 'delivered' : mode === 'disabled' ? 'unavailable' : 'pending', simulation,
        unsubscribeTokenHash: hashToken(unsubscribeToken), subscriptionGenerationId: subscriber.generationId },
    }, { upsert: true, session });
    if (result.upsertedCount && mode === 'resend') {
      const statusUrl = `${ctx.config.publicBaseUrl}/status/${encodeURIComponent(project.slug)}`;
      const content = emailContent(`${service.name}: ${update.state}`, [incident.title, update.message], { label: 'View status page', url: statusUrl }, `You subscribed to updates from ${project.name}.`, { label: 'Unsubscribe', url: `${statusUrl}#unsubscribe=${encodeURIComponent(unsubscribeToken)}` });
      await queueEmail(ctx, session, { kind: 'incident-update', to: subscriber.email, subject: `${project.name}: ${service.name} — ${update.state}`, ...content,
        dedupeKey: `notification:${notificationId}`, projectId: project._id, subscriptionId: subscriber._id, serviceId: service._id,
        incidentId: incident._id, notificationId, subscriptionGenerationId: subscriber.generationId });
    }
    count += result.upsertedCount;
  }
  return count;
}

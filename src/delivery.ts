import { ObjectId, type ClientSession, type Document } from 'mongodb';
import { type AppContext, transaction } from './core.js';

const MAX_AUTOMATIC_ATTEMPTS = 3;

/** Records simulated email outcomes atomically. No SMTP delivery is claimed. */
export async function deliverPendingAlerts(ctx: AppContext, options: {
  simulateFailure?: boolean; alertId?: ObjectId; force?: boolean; limit?: number;
} = {}): Promise<number> {
  if (!ctx.config.simulations) return 0;
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
  const subscribers = ctx.db.collection('subscriptions').find({ projectId: project._id, serviceIds: service._id, verifiedAt: { $exists: true }, revokedAt: { $exists: false } }, { session });
  for await (const subscriber of subscribers) {
    const result = await ctx.db.collection('notifications').updateOne({ subscriptionId: subscriber._id, eventKey: `incident-update:${update._id}` }, {
      $setOnInsert: { projectId: project._id, serviceId: service._id, incidentId: incident._id, updateId: update._id,
        type: 'incident_update', createdAt: ctx.now(), deliveryState: ctx.config.simulations ? 'delivered' : 'pending', simulation: ctx.config.simulations },
    }, { upsert: true, session });
    count += result.upsertedCount;
  }
  return count;
}

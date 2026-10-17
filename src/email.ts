import { randomUUID } from 'node:crypto';
import { ObjectId, type ClientSession, type Document } from 'mongodb';
import { type AppContext, emailSchema, fail, transaction } from './core.js';

const MAX_ATTEMPTS = 6;
const LEASE_MS = 60_000;
const IDEMPOTENCY_WINDOW_MS = 23 * 3600_000;

export function emailMode(ctx: AppContext): 'resend' | 'simulation' | 'disabled' {
  if (ctx.config.emailMode === 'resend' && ctx.config.resendApiKey && ctx.config.emailFrom) return 'resend';
  if (ctx.config.emailMode === 'simulation' && ctx.config.env !== 'production' && ctx.config.simulations) return 'simulation';
  return 'disabled';
}

export function requireEmailDelivery(ctx: AppContext): void {
  if (emailMode(ctx) === 'disabled') fail(503, 'EMAIL_UNAVAILABLE', 'Email delivery is not configured yet. Please contact the site owner.');
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** A small, accessible template; dynamic names and incident messages are always escaped. */
export function emailContent(title: string, paragraphs: string[], action?: { label: string; url: string }, footer?: string, footerAction?: { label: string; url: string }) {
  return {
    text: [title, ...paragraphs, ...(action ? [`${action.label}: ${action.url}`] : []), footer ?? 'Status Pulse · Clear updates, calmer operations.', ...(footerAction ? [`${footerAction.label}: ${footerAction.url}`] : [])].join('\n\n'),
    html: `<!doctype html><html lang="en"><body style="margin:0;background:#f3f5fa;color:#1d2740;font-family:Arial,sans-serif"><main style="max-width:560px;margin:32px auto;padding:32px;background:#ffffff;border-radius:16px"><p style="color:#6654e8;font-weight:bold;letter-spacing:2px">STATUS PULSE</p><h1 style="font-size:26px;line-height:1.3">${escapeHtml(title)}</h1>${paragraphs.map(paragraph => `<p style="line-height:1.7">${escapeHtml(paragraph)}</p>`).join('')}${action ? `<p style="margin:28px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#6654e8;color:#ffffff;padding:14px 20px;border-radius:10px;text-decoration:none;font-weight:bold">${escapeHtml(action.label)}</a></p><p style="font-size:12px;word-break:break-all">Or open: ${escapeHtml(action.url)}</p>` : ''}<p style="border-top:1px solid #e6e9f0;padding-top:20px;font-size:12px;line-height:1.6;color:#68748a">${escapeHtml(footer ?? 'Status Pulse · Clear updates, calmer operations.')}${footerAction ? ` <a href="${escapeHtml(footerAction.url)}">${escapeHtml(footerAction.label)}</a>` : ''}</p></main></body></html>`,
  };
}

export interface EmailInput {
  kind: string; to: string; subject: string; text: string; html?: string; dedupeKey: string;
  projectId?: ObjectId; subscriptionId?: ObjectId; alertId?: ObjectId; notificationId?: ObjectId;
  invitationId?: ObjectId; userId?: ObjectId; serviceId?: ObjectId; incidentId?: ObjectId; expiresAt?: Date;
  accountTokenHash?: string; subscriptionTokenHash?: string; subscriptionGenerationId?: ObjectId;
}

/** Called inside the originating transaction. Network requests happen only after commit. */
export async function queueEmail(ctx: AppContext, session: ClientSession | undefined, input: EmailInput): Promise<{ emailId: ObjectId; simulation: boolean }> {
  requireEmailDelivery(ctx);
  const to = emailSchema.parse(input.to);
  const simulation = emailMode(ctx) === 'simulation';
  const emailId = new ObjectId();
  const result = await ctx.db.collection('emailOutbox').findOneAndUpdate({ dedupeKey: input.dedupeKey }, { $setOnInsert: {
    _id: emailId, ...input, to, from: ctx.config.emailFrom ?? 'Status Pulse <simulation@example.test>',
    deliveryState: 'pending', simulation, attempts: 0, createdAt: ctx.now(), nextAttemptAt: ctx.now(),
  } }, { upsert: true, session, returnDocument: 'after' });
  return { emailId: result!._id, simulation: Boolean(result!.simulation) };
}

async function stillAllowed(ctx: AppContext, email: Document): Promise<boolean> {
  if (email.expiresAt && new Date(email.expiresAt) <= ctx.now()) return false;
  if (email.accountTokenHash && !await ctx.db.collection('accountTokens').findOne({ tokenHash: email.accountTokenHash, userId: email.userId, expiresAt: { $gt: ctx.now() } })) return false;
  if (email.projectId) {
    const project = await ctx.db.collection('projects').findOne({ _id: email.projectId, archivedAt: { $exists: false } });
    if (!project || (email.subscriptionId && !project.publicEnabled)) return false;
  }
  if (email.invitationId && !await ctx.db.collection('invitations').findOne({ _id: email.invitationId, acceptedAt: { $exists: false }, expiresAt: { $gt: ctx.now() } })) return false;
  if (email.subscriptionId) {
    const subscription = await ctx.db.collection('subscriptions').findOne({ _id: email.subscriptionId, revokedAt: { $exists: false } });
    if (!subscription || (email.kind === 'incident-update' && !subscription.verifiedAt)) return false;
    if (email.kind === 'incident-update' && (subscription.verificationMethod !== 'email' || String(subscription.generationId ?? '') !== String(email.subscriptionGenerationId ?? ''))) return false;
    if (email.subscriptionTokenHash && (subscription.verificationTokenHash !== email.subscriptionTokenHash || subscription.verifiedAt)) return false;
    if (email.serviceId && (!subscription.serviceIds.some((id: ObjectId) => id.equals(email.serviceId)) || !await ctx.db.collection('services').findOne({ _id: email.serviceId, publicVisible: true, archivedAt: { $exists: false } }))) return false;
    if (email.incidentId && !await ctx.db.collection('incidents').findOne({ _id: email.incidentId, publicVisible: true })) return false;
  }
  if (email.alertId && email.userId && !await ctx.db.collection('memberships').findOne({ projectId: email.projectId, userId: email.userId, role: { $in: ['owner', 'responder'] } })) return false;
  return true;
}

class ProviderError extends Error {
  constructor(readonly reason: string, readonly retryable: boolean) { super(reason); }
}

async function sendViaResend(ctx: AppContext, email: Document): Promise<string> {
  const response = await (ctx.emailFetch ?? fetch)('https://api.resend.com/emails', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${ctx.config.resendApiKey}`, 'content-type': 'application/json', 'Idempotency-Key': `status-pulse/${email._id}` },
    body: JSON.stringify({ from: email.from, to: [email.to], subject: email.subject, text: email.text, ...(email.html ? { html: email.html } : {}) }),
  });
  // Provider responses may contain addresses, content or credentials: never persist their raw text.
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderError(`email_provider_http_${response.status}`, response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string' || body.id.length > 200) throw new ProviderError('email_provider_invalid_response', true);
  return body.id;
}

async function recordOutcome(ctx: AppContext, email: Document, leaseToken: string, outcome: 'sent' | 'simulated' | 'failed' | 'cancelled', detail: { providerId?: string; reason?: string; retryable?: boolean } = {}) {
  await transaction(ctx, async session => {
    const now = ctx.now();
    const retryable = outcome === 'failed' && detail.retryable && email.attempts < MAX_ATTEMPTS;
    const changes: Document = { deliveryState: retryable ? 'retry' : outcome, updatedAt: now };
    if (detail.reason) changes.lastError = detail.reason;
    if (detail.providerId) changes.providerId = detail.providerId;
    if (outcome === 'sent') changes.sentAt = now; // Accepted by Resend, not proof of delivery to an inbox.
    if (outcome === 'simulated') changes.simulatedAt = now;
    if (retryable) changes.nextAttemptAt = new Date(now.getTime() + 30_000 * 2 ** (email.attempts - 1));
    if (outcome === 'failed' && !retryable) changes.retryExhaustedAt = now;
    const unset: Document = { leaseToken: '', leaseUntil: '' };
    if (!retryable) unset.nextAttemptAt = '';
    if (outcome === 'sent' || outcome === 'simulated') Object.assign(unset, { lastError: '', retryExhaustedAt: '' });
    const updated = await ctx.db.collection('emailOutbox').updateOne({ _id: email._id, leaseToken }, { $set: changes, $unset: unset }, { session });
    if (!updated.modifiedCount) return;
    await ctx.db.collection('emailAttempts').insertOne({ emailId: email._id, attempt: email.attempts, outcome, createdAt: now,
      simulation: email.simulation, ...(detail.reason ? { reason: detail.reason } : {}) }, { session });
    if (email.notificationId) await ctx.db.collection('notifications').updateOne({ _id: email.notificationId }, { $set: {
      deliveryState: outcome === 'simulated' ? 'delivered' : retryable ? 'pending' : outcome, simulation: email.simulation,
      ...(outcome === 'sent' ? { sentAt: now } : {}), ...(detail.reason ? { lastError: detail.reason } : {}),
    } }, { session });
    if (email.alertId) {
      const recipients = await ctx.db.collection('emailOutbox').find({ alertId: email.alertId }, { session }).toArray();
      const active = recipients.filter(recipient => recipient.deliveryState !== 'cancelled');
      const state = !active.length ? 'cancelled' : active.some(recipient => recipient.deliveryState === 'failed') ? 'failed'
        : active.every(recipient => recipient.deliveryState === 'sent') ? 'sent' : 'pending';
      const alert = await ctx.db.collection('alerts').findOneAndUpdate({ _id: email.alertId }, { $set: { deliveryState: state, simulation: false,
        ...(state === 'sent' ? { sentAt: now } : {}),
        ...(detail.reason ? { lastError: detail.reason } : {}), ...(state === 'failed' ? { retryExhaustedAt: now } : {}),
      }, $inc: { attempts: 1 }, ...(state === 'sent' ? { $unset: { lastError: '', retryExhaustedAt: '', nextAttemptAt: '' } } : {}) }, { session, returnDocument: 'after' });
      if (alert) await ctx.db.collection('alertAttempts').insertOne({ alertId: email.alertId, emailId: email._id, attempt: alert.attempts, outcome, simulation: false,
        createdAt: now, ...(detail.reason ? { reason: detail.reason } : {}) }, { session });
    }
  });
}

/** Atomic leases allow both API and worker processes to drain the same durable outbox safely. */
export async function deliverPendingEmails(ctx: AppContext, options: { limit?: number; emailId?: ObjectId; alertId?: ObjectId; force?: boolean } = {}): Promise<number> {
  const mode = emailMode(ctx);
  if (mode === 'disabled') return 0;
  const limit = Math.min(100, Math.max(1, options.limit ?? 25));
  let processed = 0;
  const seen: ObjectId[] = [];
  for (let index = 0; index < limit; index++) {
    const now = ctx.now();
    const leaseToken = randomUUID();
    const filter: Document = { simulation: mode === 'simulation', _id: { $nin: seen }, $or: [
      { deliveryState: { $in: options.force ? ['pending', 'retry', 'failed'] : ['pending', 'retry'] }, ...(options.force ? {} : { nextAttemptAt: { $lte: now }, attempts: { $lt: MAX_ATTEMPTS } }) },
      { deliveryState: 'sending', leaseUntil: { $lte: now } },
    ], ...(options.emailId ? { _id: options.emailId } : {}), ...(options.alertId ? { alertId: options.alertId } : {}) };
    const email = await ctx.db.collection('emailOutbox').findOneAndUpdate(filter, {
      $set: { deliveryState: 'sending', leaseToken, leaseUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 },
    }, { sort: { createdAt: 1, _id: 1 }, returnDocument: 'after' });
    if (!email) break;
    processed++;
    seen.push(email._id);
    if (email.attempts > MAX_ATTEMPTS && !options.force) {
      await recordOutcome(ctx, email, leaseToken, 'failed', { reason: 'email_retry_limit_reached', retryable: false });
      continue;
    }
    if (!email.firstAttemptAt) {
      email.firstAttemptAt = now;
      await ctx.db.collection('emailOutbox').updateOne({ _id: email._id, leaseToken }, { $set: { firstAttemptAt: now } });
    }
    if (now.getTime() - new Date(email.firstAttemptAt).getTime() >= IDEMPOTENCY_WINDOW_MS) {
      await recordOutcome(ctx, email, leaseToken, 'failed', { reason: 'email_retry_window_expired', retryable: false });
      continue;
    }
    if (!await stillAllowed(ctx, email)) {
      await recordOutcome(ctx, email, leaseToken, 'cancelled', { reason: 'email_no_longer_applicable' });
      continue;
    }
    if (mode === 'simulation') {
      await recordOutcome(ctx, email, leaseToken, 'simulated');
      continue;
    }
    let providerId: string;
    try { providerId = await sendViaResend(ctx, email); }
    catch (error) {
      const reason = error instanceof ProviderError ? error.reason : 'email_provider_unreachable';
      await recordOutcome(ctx, email, leaseToken, 'failed', { reason, retryable: !(error instanceof ProviderError) || error.retryable });
      continue;
    }
    // A database failure here intentionally leaves the lease in place; retry uses the same provider idempotency key.
    await recordOutcome(ctx, email, leaseToken, 'sent', { providerId });
  }
  return processed;
}

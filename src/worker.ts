import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { scheduleDue, runNextCheck, expireOverridesAndRecordStale } from './monitoring.js';
import { deliverPendingAlerts } from './delivery.js';
import { deliverPendingEmails } from './email.js';
import { describeStartupError } from './startup-error.js';

async function main() {
  const ctx = await connect(loadConfig());
  const workerId = randomUUID();
  let stopped = false;
  let mailRun: Promise<void> | undefined;
  process.once('SIGTERM', () => { stopped = true; });
  process.once('SIGINT', () => { stopped = true; });
  process.on('message', message => { if (message === 'shutdown') stopped = true; });
  console.log('Status Pulse scheduler and check worker started.');
  try {
    while (!stopped) {
      try {
        await ctx.db.collection('workerHeartbeats').updateOne({ workerId }, { $set: { lastSeenAt: ctx.now(), state: 'running' } }, { upsert: true });
        await scheduleDue(ctx);
        await expireOverridesAndRecordStale(ctx);
        await Promise.all(Array.from({ length: ctx.config.workerConcurrency }, () => runNextCheck(ctx)));
        // A slow email provider must not delay monitoring or worker heartbeats.
        if (!mailRun) mailRun = (async () => {
          await deliverPendingAlerts(ctx, { limit: 5 });
          await deliverPendingEmails(ctx, { limit: 5 });
        })().catch(async error => {
          const errorType = error instanceof Error ? error.name : 'Error';
          console.error(JSON.stringify({ event: 'email.tick_failed', errorType }));
          await ctx.db.collection('operationalEvents').insertOne({ type: 'email_tick_failure', errorType, workerId, createdAt: ctx.now() }).catch(() => undefined);
        }).finally(() => { mailRun = undefined; });
      } catch (error) {
        const errorType = error instanceof Error ? error.name : 'Error';
        console.error(JSON.stringify({ event: 'worker.tick_failed', errorType }));
        await ctx.db.collection('operationalEvents').insertOne({ type: 'worker_tick_failure', errorType, workerId, createdAt: ctx.now() }).catch(() => undefined);
      }
      if (!stopped) await delay(ctx.config.workerPollMs);
    }
  } finally {
    await mailRun;
    await ctx.db.collection('workerHeartbeats').updateOne({ workerId }, { $set: { state: 'stopped', lastSeenAt: ctx.now() } }).catch(() => undefined);
    await ctx.client.close();
    process.disconnect?.();
  }
}
main().catch(error => { console.error(`Worker startup failed: ${describeStartupError(error)}`); process.exitCode = 1; });

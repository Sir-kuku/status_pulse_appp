import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { describeStartupError } from './startup-error.js';
import { deliverPendingEmails } from './email.js';

async function main() {
  const config = loadConfig();
  const ctx = await connect(config);
  // Web delivery keeps account and invitation mail moving even when monitoring is idle.
  // The durable lease also permits the independent worker to process this same queue.
  let closing = false;
  let mailRun: Promise<unknown> | undefined;
  const mailTimer = setInterval(() => {
    if (closing || mailRun || config.emailMode !== 'resend') return;
    mailRun = deliverPendingEmails(ctx, { limit: 10 }).catch(error => {
      console.error(JSON.stringify({ event: 'email.tick_failed', errorType: error instanceof Error ? error.name : 'Error' }));
    }).finally(() => { mailRun = undefined; });
  }, 2000);
  mailTimer.unref();
  const server = createApp(ctx).listen(config.port, '0.0.0.0', () => console.log(`Status Pulse API listening on port ${config.port}. API reference: /docs`));
  server.on('error', async error => { closing = true; clearInterval(mailTimer); console.error(`API could not listen (${error.name}).`); await mailRun; await ctx.client.close(); process.exitCode = 1; });
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(mailTimer);
    const timer = setTimeout(() => { server.closeAllConnections(); }, 10000); timer.unref();
    server.close(() => { void (async () => { await mailRun; await ctx.client.close(); })().finally(() => clearTimeout(timer)); });
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
main().catch(error => {
  console.error(`API startup failed: ${describeStartupError(error)}`);
  process.exitCode = 1;
});

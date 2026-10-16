import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { describeStartupError } from './startup-error.js';

async function main() {
  const config = loadConfig();
  const ctx = await connect(config);
  const server = createApp(ctx).listen(config.port, '0.0.0.0', () => console.log(`Status Pulse API listening on port ${config.port}. API reference: /docs`));
  server.on('error', async error => { console.error(`API could not listen (${error.name}).`); await ctx.client.close(); process.exitCode = 1; });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => { server.closeAllConnections(); }, 10000); timer.unref();
    server.close(() => { void ctx.client.close().finally(() => clearTimeout(timer)); });
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
main().catch(error => {
  console.error(`API startup failed: ${describeStartupError(error)}`);
  process.exitCode = 1;
});

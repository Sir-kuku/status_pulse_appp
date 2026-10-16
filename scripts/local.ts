import { spawn } from 'node:child_process';
import { startDevDatabase } from './dev-db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect } from '../src/db.js';

const config = loadConfig();
if (!config.mongoUri.startsWith('mongodb://127.0.0.1:27018/')) throw new Error('npm run local uses the isolated local database. Use npm run dev and npm run dev:worker for Atlas configuration.');
const replica = await startDevDatabase();
try {
  const ctx = await connect(config);
  const server = createApp(ctx).listen(config.port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const worker = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  let closing = false;
  const stop = async () => {
    if (closing) return; closing = true;
    if (worker.connected) worker.send('shutdown');
    await new Promise<void>(resolve => {
      if (worker.exitCode !== null) return resolve();
      const timeout = setTimeout(() => { worker.kill(); resolve(); }, 15000);
      worker.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    await ctx.client.close();
    await replica.stop({ doCleanup: false });
    process.disconnect?.();
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  process.on('message', message => { if (message === 'shutdown') void stop(); });
  worker.once('error', error => { console.error(`Worker launch failed (${error.name}).`); process.exitCode = 1; void stop(); });
  worker.once('exit', () => { if (!closing) { console.error('Worker stopped unexpectedly.'); process.exitCode = 1; void stop(); } });
  console.log(`Status Pulse running: http://localhost:${config.port}/docs — Ctrl+C stops API, worker, and database while preserving data.`);
} catch (error) { await replica.stop({ doCleanup: false }); throw error; }

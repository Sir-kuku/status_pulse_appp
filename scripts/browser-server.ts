// Isolated browser-test fixture. Never used by the API or worker entry points.
import { createTestContext } from '../tests/helpers.js';
import { createApp } from '../src/app.js';
import { runNextCheck, scheduleDue } from '../src/monitoring.js';

const { ctx, close } = await createTestContext();
const app = createApp(ctx);
let stopping = false;
let running: Promise<void> | undefined;
const server = app.listen(3107, '127.0.0.1');
// Injected transport keeps browser tests deterministic and makes no HTTP probes.
const timer = setInterval(() => {
  if (stopping || running) return;
  running = (async () => {
    await scheduleDue(ctx);
    for (let i = 0; i < 20; i++) {
      if (!await runNextCheck(ctx, async () => ({ success: true, httpStatus: 200, latencyMs: 82, failureReason: null }))) break;
    }
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { running = undefined; });
}, 500);

async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(timer); await running;
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
  await close();
}
// The fixture intercepts its own teardown request; no test routes enter createApp.
server.prependListener('request', (req, res) => {
  if (req.url !== '/__browser_fixture_stop' || req.method !== 'POST') return;
  req.url = '/health/live';
  res.once('finish', () => { void stop(); });
});
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
console.log('Isolated browser fixture ready on http://127.0.0.1:3107');

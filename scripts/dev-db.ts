import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureMongoBinary } from './mongo-runtime.js';

export async function startDevDatabase() {
  configureMongoBinary();
  // Never silently choose another port or attach to an existing MongoDB service.
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error('Port 27018 is in use. Stop the earlier Status Pulse development database before starting another.')));
    probe.listen(27018, '127.0.0.1', () => probe.close(() => resolve()));
  });
  const dbPath = path.resolve('.local/mongo');
  await mkdir(dbPath, { recursive: true });
  const replica = await MongoMemoryReplSet.create({
    instanceOpts: [{ port: 27018, dbPath, launchTimeout: 60000 }],
    replSet: { count: 1, name: 'status-pulse-dev', ip: '127.0.0.1', storageEngine: 'wiredTiger', dispose: { enabled: false } },
  });
  if (!replica.getUri().includes(':27018/')) { await replica.stop({ doCleanup: false }); throw new Error('Development database did not bind to the expected port.'); }
  console.log(`Development replica set ready on 127.0.0.1:27018. Data retained in ${dbPath}`);
  return replica;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const replica = await startDevDatabase();
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await replica.stop({ doCleanup: false }); };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  process.on('message', message => { if (message === 'shutdown') void stop().then(() => process.disconnect?.()); });
}

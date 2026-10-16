import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { migrate } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/core.js';
import { configureMongoBinary } from '../scripts/mongo-runtime.js';

export async function createTestContext() {
  configureMongoBinary();
  const replica = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 60000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const client = new MongoClient(replica.getUri());
  try {
    await client.connect();
    const db = client.db('status_pulse_test');
    await migrate(db);
    const config = loadConfig({ NODE_ENV: 'test', MONGODB_URI: replica.getUri(), MONGODB_DATABASE: 'status_pulse_test' });
    const ctx: AppContext = { client, db, config, now: () => new Date() };
    return { ctx, close: async () => { await client.close(); await replica.stop(); } };
  } catch (error) { await client.close(); await replica.stop(); throw error; }
}

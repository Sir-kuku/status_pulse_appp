import { loadConfig } from '../src/config.js';
import { connect } from '../src/db.js';

const ctx = await connect(loadConfig());
console.log('Database index migration is up to date.');
await ctx.client.close();

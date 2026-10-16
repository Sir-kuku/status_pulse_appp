import { loadConfig } from '../src/config.js';
import { connect } from '../src/db.js';
import { audit, emailSchema, transaction } from '../src/core.js';

const args = process.argv.slice(2);
const email = emailSchema.parse(args[0] === '--email' ? args[1] : args[0]);
const ctx = await connect(loadConfig());
try {
  await transaction(ctx, async session => {
    const user = await ctx.db.collection('users').findOneAndUpdate({ email }, { $set: { platformRole: 'admin' } }, { session, returnDocument: 'after' });
    if (!user) throw new Error('Register the account before promoting it.');
    await audit(ctx, session, { action: 'admin.account_promoted', resourceId: user._id, metadata: { source: 'operator_cli' } });
  });
  console.log('Existing account granted platform administrator access.');
} finally { await ctx.client.close(); }

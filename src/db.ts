import { MongoClient, type Db, type IndexDescription } from 'mongodb';
import type { AppContext, Config } from './core.js';
import { DatabaseStartupError } from './startup-error.js';

// Every index is named: migrations are safe to re-run and uniqueness is enforced by MongoDB.
const indexes: Record<string, IndexDescription[]> = {
  users: [{ key: { email: 1 }, unique: true, name: 'user_email_unique' }],
  sessions: [{ key: { tokenHash: 1 }, unique: true, name: 'session_token_unique' }, { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'session_expiry' }],
  projects: [{ key: { slug: 1 }, unique: true, name: 'project_slug_unique' }],
  memberships: [{ key: { projectId: 1, userId: 1 }, unique: true, name: 'membership_unique' }, { key: { userId: 1 }, name: 'membership_user' }],
  invitations: [{ key: { tokenHash: 1 }, unique: true, name: 'invitation_token_unique' }],
  services: [{ key: { enabled: 1, nextCheckAt: 1 }, name: 'due_services' }, { key: { projectId: 1 }, name: 'project_services' }],
  serviceVersions: [{ key: { serviceId: 1, version: 1 }, unique: true, name: 'service_version_unique' }],
  checkJobs: [{ key: { serviceId: 1, slot: 1 }, unique: true, name: 'job_slot_unique' }, { key: { state: 1, availableAt: 1, leaseUntil: 1 }, name: 'claim_jobs' }],
  checkResults: [{ key: { jobId: 1 }, unique: true, name: 'result_job_unique' }, { key: { serviceId: 1, checkedAt: -1 }, name: 'service_result_history' }],
  statusHistory: [{ key: { serviceId: 1, createdAt: -1 }, name: 'service_status_history' }],
  incidents: [{ key: { serviceId: 1, active: 1 }, unique: true, partialFilterExpression: { active: true }, name: 'one_active_incident' }, { key: { projectId: 1, createdAt: -1 }, name: 'project_incidents' }],
  incidentUpdates: [{ key: { incidentId: 1, createdAt: -1 }, name: 'incident_updates' }],
  alerts: [{ key: { dedupeKey: 1 }, unique: true, name: 'alert_dedupe' }, { key: { projectId: 1, createdAt: -1 }, name: 'project_alerts' }],
  alertAttempts: [{ key: { alertId: 1, attempt: 1 }, unique: true, name: 'alert_attempt_unique' }],
  subscriptions: [{ key: { projectId: 1, email: 1 }, unique: true, name: 'subscription_unique' }, { key: { verificationTokenHash: 1 }, unique: true, sparse: true, name: 'subscription_token_unique' }],
  notifications: [{ key: { subscriptionId: 1, eventKey: 1 }, unique: true, name: 'subscriber_notification_unique' }],
  simulatedMail: [{ key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'simulated_mail_expiry' }, { key: { projectId: 1, createdAt: -1 }, name: 'project_simulated_mail' }],
  payments: [{ key: { projectId: 1, idempotencyKey: 1 }, unique: true, name: 'payment_idempotency' }],
  auditEvents: [{ key: { projectId: 1, createdAt: -1 }, name: 'project_audit' }],
  operationalEvents: [{ key: { createdAt: -1 }, name: 'operations_history' }],
  workerHeartbeats: [{ key: { workerId: 1 }, unique: true, name: 'worker_id_unique' }, { key: { lastSeenAt: 1 }, expireAfterSeconds: 604800, name: 'worker_history_expiry' }],
  migrations: [{ key: { name: 1 }, unique: true, name: 'migration_name_unique' }],
};
export async function migrate(db: Db): Promise<void> {
  for (const [name, specs] of Object.entries(indexes)) {
    await db.collection(name).createIndexes(specs);
  }
  await db.collection('migrations').updateOne({ name: '001_initial_indexes' }, { $setOnInsert: { appliedAt: new Date() } }, { upsert: true });
}
export async function connect(config: Config): Promise<AppContext> {
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 20 });
  let phase: ConstructorParameters<typeof DatabaseStartupError>[0] = 'connecting';
  try {
    await client.connect();
    const db = client.db(config.database);
    phase = 'checking replica set';
    const hello = await db.command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('Status Pulse requires a MongoDB replica set for transactions. Use Atlas or npm run dev:db.');
    phase = 'creating indexes';
    await migrate(db);
    return { client, db, config, now: () => new Date() };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new DatabaseStartupError(phase, error);
  }
}

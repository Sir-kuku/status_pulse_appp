import 'dotenv/config';
import { z } from 'zod';
import type { Config } from './core.js';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const settings = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    MONGODB_URI: z.string().startsWith('mongodb').default('mongodb://127.0.0.1:27018/status_pulse?replicaSet=status-pulse-dev'),
    MONGODB_DATABASE: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('status_pulse'),
    PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
    WORKER_POLL_MS: z.coerce.number().int().min(250).max(60000).default(1000),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    ENABLE_SIMULATIONS: z.enum(['true', 'false']).default('true'),
  }).parse(env);
  if (settings.NODE_ENV === 'production' && new URL(settings.PUBLIC_BASE_URL).protocol !== 'https:') throw new Error('PUBLIC_BASE_URL must use HTTPS in production.');
  return { env: settings.NODE_ENV, port: settings.PORT, mongoUri: settings.MONGODB_URI, database: settings.MONGODB_DATABASE,
    publicBaseUrl: settings.PUBLIC_BASE_URL.replace(/\/$/, ''), workerConcurrency: settings.WORKER_CONCURRENCY,
    workerPollMs: settings.WORKER_POLL_MS, sessionTtlHours: settings.SESSION_TTL_HOURS, simulations: settings.ENABLE_SIMULATIONS === 'true' };
}

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
    EMAIL_MODE: z.enum(['resend', 'simulation', 'disabled']).optional(),
    EMAIL_FROM: z.string().trim().max(254).refine(value => !/[\r\n]/.test(value), 'EMAIL_FROM must be a single line.').optional(),
    RESEND_API_KEY: z.string().trim().min(1).optional(),
    GOOGLE_CLIENT_ID: z.string().trim().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().trim().min(1).optional(),
    GITHUB_CLIENT_ID: z.string().trim().min(1).optional(),
    GITHUB_CLIENT_SECRET: z.string().trim().min(1).optional(),
    CREATOR_NAME: z.string().trim().min(1).max(100).default('Sir. Kuku'),
    CREATOR_URL: z.url().refine(value => new URL(value).protocol === 'https:', 'CREATOR_URL must use HTTPS.').default('https://github.com/Sir-kuku'),
  }).parse(env);
  if (settings.NODE_ENV === 'production' && new URL(settings.PUBLIC_BASE_URL).protocol !== 'https:') throw new Error('PUBLIC_BASE_URL must use HTTPS in production.');
  const publicUrl = new URL(settings.PUBLIC_BASE_URL);
  if (!['http:', 'https:'].includes(publicUrl.protocol)) throw new Error('PUBLIC_BASE_URL must use HTTP or HTTPS.');
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') throw new Error('PUBLIC_BASE_URL must be an origin without a path, query, or credentials.');
  const emailMode = settings.EMAIL_MODE ?? (settings.RESEND_API_KEY && settings.EMAIL_FROM ? 'resend' : settings.NODE_ENV === 'production' ? 'disabled' : settings.ENABLE_SIMULATIONS === 'true' ? 'simulation' : 'disabled');
  if (emailMode === 'simulation' && settings.NODE_ENV === 'production') throw new Error('Simulated email is not allowed in production. Configure Resend or disable email.');
  if (emailMode === 'resend' && (!settings.RESEND_API_KEY || !settings.EMAIL_FROM)) throw new Error('Resend email requires RESEND_API_KEY and EMAIL_FROM.');
  if (emailMode === 'resend') {
    const address = settings.EMAIL_FROM!.match(/<([^<>]+)>$/)?.[1] ?? settings.EMAIL_FROM!;
    if (!z.email().safeParse(address).success) throw new Error('EMAIL_FROM must contain a valid email address.');
  }
  if (Boolean(settings.GOOGLE_CLIENT_ID) !== Boolean(settings.GOOGLE_CLIENT_SECRET)) throw new Error('Google sign-in requires both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  if (Boolean(settings.GITHUB_CLIENT_ID) !== Boolean(settings.GITHUB_CLIENT_SECRET)) throw new Error('GitHub sign-in requires both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.');
  return { env: settings.NODE_ENV, port: settings.PORT, mongoUri: settings.MONGODB_URI, database: settings.MONGODB_DATABASE,
    publicBaseUrl: settings.PUBLIC_BASE_URL.replace(/\/$/, ''), workerConcurrency: settings.WORKER_CONCURRENCY,
    workerPollMs: settings.WORKER_POLL_MS, sessionTtlHours: settings.SESSION_TTL_HOURS, simulations: settings.ENABLE_SIMULATIONS === 'true',
    emailMode, emailFrom: settings.EMAIL_FROM, resendApiKey: settings.RESEND_API_KEY,
    googleClientId: settings.GOOGLE_CLIENT_ID, googleClientSecret: settings.GOOGLE_CLIENT_SECRET,
    githubClientId: settings.GITHUB_CLIENT_ID, githubClientSecret: settings.GITHUB_CLIENT_SECRET,
    creatorName: settings.CREATOR_NAME, creatorUrl: settings.CREATOR_URL };
}

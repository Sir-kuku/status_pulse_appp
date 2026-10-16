import { MongoNetworkError, MongoParseError, MongoServerError, MongoServerSelectionError } from 'mongodb';
import { ZodError } from 'zod';

type DatabaseStartupPhase = 'connecting' | 'checking replica set' | 'creating indexes';

export class DatabaseStartupError extends Error {
  constructor(readonly phase: DatabaseStartupPhase, cause: unknown) {
    super('Database startup failed', { cause });
  }
}

// Never log raw database messages: they can contain credentials, commands, or document values.
export function describeStartupError(error: unknown): string {
  const phase = error instanceof DatabaseStartupError ? ` during ${error.phase}` : '';
  const cause = error instanceof DatabaseStartupError ? error.cause : error;
  if (cause instanceof MongoServerError) {
    const code = typeof cause.code === 'number' && Number.isSafeInteger(cause.code) ? cause.code : undefined;
    const label = `MongoServerError${code === undefined ? '' : ` code=${code}`}${phase}`;
    if (code === 18 || (code === 8000 && /^(?:bad auth\s*:\s*)?authentication failed\b/i.test(cause.message))) {
      return `${label}. Authentication failed. Check the database username and password in MONGODB_URI, percent-encode the password, and use authSource=admin for Atlas.`;
    }
    if (code === 13) {
      return `${label}. Database permission denied. Check MONGODB_DATABASE and grant the database user readWrite on that database (status_pulse for this project).`;
    }
    if (code === 85 || code === 86) {
      return `${label}. An existing index conflicts with the required definition. Review the database indexes before changing them; preserve existing data.`;
    }
    if (code === 11000) {
      return `${label}. Existing data conflicts with a unique index. Review duplicate records before retrying startup.`;
    }
    return `${label}. MongoDB rejected a startup command. Use this error code and phase to check database access, limits, and index configuration.`;
  }
  if (cause instanceof MongoServerSelectionError || cause instanceof MongoNetworkError) {
    return `MongoDB connection unavailable${phase}. Check the Atlas cluster is running, the URI hostname is correct, and Render outbound IP ranges are allowed in Atlas.`;
  }
  if (cause instanceof MongoParseError) {
    return 'Invalid MongoDB connection string. Check MONGODB_URI syntax and percent-encode the username/password components.';
  }
  if (cause instanceof ZodError) {
    return 'Invalid environment configuration. Check the variables against .env.example and docs/deployment.md.';
  }
  return `Startup error${phase}. Check database connectivity, replica set configuration, and environment settings.`;
}

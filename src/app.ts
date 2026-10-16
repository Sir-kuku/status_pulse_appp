import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ZodError } from 'zod';
import { actor, effectiveStatus, fail, HttpError, pagination, requireUser, type AppContext } from './core.js';
import { authRouter } from './auth-routes.js';
import { projectRouter } from './project-routes.js';
import { serviceRouter } from './service-routes.js';
import { incidentRouter } from './incident-routes.js';
import { publicRouter } from './public-routes.js';

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  // Render terminates TLS at one trusted reverse proxy. Direct local deployments trust none.
  if (ctx.config.env === 'production') app.set('trust proxy', 1);
  app.use(helmet());
  app.use((_req, res, next) => { res.locals.requestId = randomUUID(); res.setHeader('X-Request-ID', res.locals.requestId); next(); });
  app.use(express.json({ limit: '64kb' }));
  const limitMessage = { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } };
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false, message: limitMessage, skip: () => ctx.config.env === 'test' }));
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: limitMessage, skip: () => ctx.config.env === 'test' }));
  app.get('/', (_req, res) => { res.json({ name: 'Status Pulse', version: '0.1.0', docs: '/docs', health: '/health/ready', payments: 'simulation only' }); });
  app.get('/health/live', (_req, res) => { res.json({ status: 'ok' }); });
  app.get('/health/ready', async (_req, res) => {
    try { await ctx.db.command({ ping: 1 }, { timeoutMS: 2000 }); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.get('/status/:slug', async (req, res) => {
    const project = await ctx.db.collection('projects').findOne({ slug: req.params.slug, publicEnabled: true, archivedAt: { $exists: false } });
    if (!project) return fail(404, 'NOT_FOUND', 'Public project not found.');
    const services = await ctx.db.collection('services').find({ projectId: project._id, publicVisible: true, archivedAt: { $exists: false } }).sort({ name: 1 }).limit(100).toArray();
    const incidents = await ctx.db.collection('incidents').find({ projectId: project._id, serviceId: { $in: services.map(s => s._id) }, publicVisible: true }).sort({ createdAt: -1 }).limit(20).toArray();
    const escape = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    const rows = services.map(s => `<li><strong>${escape(s.name)}</strong> <span>${escape(effectiveStatus(s, ctx.now()))}</span></li>`).join('');
    const timeline = incidents.map(i => `<li><strong>${escape(i.title)}</strong> <span>${escape(i.state)}</span><p>${escape(new Date(i.updatedAt).toISOString())}</p></li>`).join('');
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(project.name)} | Status Pulse</title><style>body{font:18px system-ui,sans-serif;background:#f4f7fa;color:#142337;max-width:800px;margin:48px auto;padding:0 24px}h1{font-size:36px}ul{list-style:none;padding:0}li{background:white;padding:20px;margin:12px 0;border:1px solid #d7e0e9;border-radius:10px}span{float:right}p{color:#536478;font-size:15px}a{color:#2652b4}</style><main><p>STATUS PULSE</p><h1>${escape(project.name)}</h1><p>Current service status. Refresh this page for the latest observations.</p><h2>Services</h2><ul>${rows || '<li>No public services.</li>'}</ul><h2>Recent incidents</h2><ul>${timeline || '<li>No published incidents.</li>'}</ul><p>Showing up to 100 services and 20 incidents. Timestamps use UTC.</p><a href="/api/public/projects/${encodeURIComponent(project.slug)}">Public status API</a></main></html>`);
  });
  app.get('/api/openapi.json', async (_req, res) => {
    const spec = await readFile(path.resolve('docs/openapi.json'), 'utf8');
    res.type('application/json').send(spec);
  });
  app.get('/docs', async (_req, res) => {
    const spec = JSON.parse(await readFile(path.resolve('docs/openapi.json'), 'utf8'));
    const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    const rows = Object.entries(spec.paths as Record<string, Record<string, { summary?: string }>>).flatMap(([route, methods]) =>
      Object.entries(methods).filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method)).map(([method, operation]) =>
        `<tr><td>${method.toUpperCase()}</td><td><code>${escape(route)}</code></td><td>${escape(operation.summary ?? '')}</td></tr>`)).join('');
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Status Pulse API</title><body><main><h1>Status Pulse API</h1><p>Weeks 1–4 backend. <a href="/api/openapi.json">Download OpenAPI contract</a> and import it into Postman.</p><p>Register or log in, then send the returned token as <code>Authorization: Bearer TOKEN</code>. Project roles control access. Public routes need no login. Email and payments are simulated.</p><table><thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`);
  });
  app.use('/api/auth', authRouter(ctx));
  app.use('/api/public', publicRouter(ctx));
  app.use('/api/admin', requireUser(ctx), (_req, res, next) => {
    if (actor(res).platformRole !== 'admin') return next(new HttpError(403, 'FORBIDDEN', 'Platform administrator access is required.'));
    next();
  });
  app.get('/api/admin/operations', async (req, res) => {
    const { limit, offset } = pagination(req);
    const [events, workers, failedChecks, failedAlerts] = await Promise.all([
      ctx.db.collection('operationalEvents').find().sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray(),
      ctx.db.collection('workerHeartbeats').find({}).limit(100).toArray(),
      ctx.db.collection('checkJobs').countDocuments({ state: 'failed' }),
      ctx.db.collection('alerts').countDocuments({ deliveryState: 'failed' }),
    ]);
    res.json({ events, workers: workers.map(w => ({ ...w, healthy: w.state === 'running' && ctx.now().getTime() - new Date(w.lastSeenAt).getTime() < 180000 })), failedChecks, failedAlerts, limit, offset });
  });
  app.get('/api/admin/audit', async (req, res) => {
    const { limit, offset } = pagination(req);
    const items = await ctx.db.collection('auditEvents').find().sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).toArray();
    res.json({ items, limit, offset });
  });
  app.use('/api/projects', serviceRouter(ctx));
  app.use('/api/projects', incidentRouter(ctx));
  app.use('/api', projectRouter(ctx));
  app.use((_req, _res) => fail(404, 'NOT_FOUND', 'Route not found.'));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    let status = 500, code = 'INTERNAL_ERROR', message = 'An unexpected error occurred.';
    let fields: { path: string; message: string }[] | undefined;
    if (error instanceof HttpError) ({ status, code, message } = error);
    else if (error instanceof ZodError) {
      status = 422; code = 'VALIDATION_ERROR'; message = 'Check the request fields.';
      fields = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }));
    } else if (error?.code === 11000) { status = 409; code = 'CONFLICT'; message = 'A resource with those unique values already exists.'; }
    else if (error?.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; message = 'Request body must be valid JSON.'; }
    else if (error?.type === 'entity.too.large') { status = 413; code = 'BODY_TOO_LARGE'; message = 'Request body exceeds 64 KB.'; }
    if (status >= 500) console.error(JSON.stringify({ event: 'request.failed', requestId: res.locals.requestId, errorType: error?.constructor?.name ?? 'Error' }));
    res.status(status).json({ error: { code, message, ...(fields ? { fields } : {}), requestId: res.locals.requestId } });
  };
  app.use(errors);
  return app;
}

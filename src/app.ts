import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ZodError } from 'zod';
import { actor, fail, HttpError, pagination, requireUser, type AppContext } from './core.js';
import { authRouter } from './auth-routes.js';
import { projectRouter } from './project-routes.js';
import { serviceRouter } from './service-routes.js';
import { incidentRouter } from './incident-routes.js';
import { publicRouter } from './public-routes.js';
import { publicPage } from './public-page.js';

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  // Render terminates TLS at one trusted reverse proxy. Direct local deployments trust none.
  if (ctx.config.env === 'production') app.set('trust proxy', 1);
  app.use(helmet());
  app.use((_req, res, next) => { res.locals.requestId = randomUUID(); res.setHeader('X-Request-ID', res.locals.requestId); next(); });
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const limitMessage = { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } };
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false, message: limitMessage, skip: () => ctx.config.env === 'test' }));
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: limitMessage,
    skip: req => ctx.config.env === 'test' || (req.method === 'GET' && req.path === '/options') }));
  app.use('/assets', express.static(path.resolve('public'), { index: false, dotfiles: 'deny', maxAge: 0 }));
  app.get('/', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.resolve('public/index.html')); });
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
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(publicPage(project, services, incidents, ctx));
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
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Status Pulse · API reference</title><link rel="icon" href="/assets/favicon.svg"><script src="/assets/preferences.js"></script><link rel="stylesheet" href="/assets/theme.css"></head><body class="public-layout"><main class="public-container"><header class="public-header"><a class="brand" href="/"><span class="brand-icon">ϟ</span>Status<span>Pulse</span></a><div class="theme-controls" data-theme-control></div><a class="button" href="/">Open workspace →</a></header><div class="page-heading"><div><p class="eyebrow">BUILT TO CONNECT</p><h1>API reference</h1><p>The complete Status Pulse contract, from accounts to incident response.</p></div><a class="button primary" href="/api/openapi.json" download="status-pulse-openapi.json">Download OpenAPI ↗</a></div><section class="panel panel-body"><h2>Your first request</h2><p>Register or sign in, then send your session token as <code>Authorization: Bearer TOKEN</code>. Your project role determines what you can access. Public routes work without an account.</p><p>Import the OpenAPI file into Postman for request schemas, response examples, permissions, and error codes.</p><p class="notice">Email delivery and Google/GitHub sign-in use the providers configured by the operator. Payments remain a clearly labelled demonstration; no money is charged.</p></section><section class="panel"><div class="table-wrap"><table><thead><tr><th>METHOD</th><th>ENDPOINT</th><th>PURPOSE</th></tr></thead><tbody>${rows}</tbody></table></div></section><footer class="public-footer"><span>Status Pulse · API reference</span><span data-creator-credit></span></footer></main></body></html>`);
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

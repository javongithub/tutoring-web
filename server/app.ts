import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AuthConfig, authConfig, makeAuth } from './auth.ts';
import { type DB, one, run } from './db.ts';
import adminRoutes from './routes/admin.ts';
import publicRoutes from './routes/public.ts';
import { type Notifier, createNotifier } from './lib/notify.ts';
import { type Reporter, aiAvailable, createReporter } from './lib/reports.ts';

export interface AppOptions {
  /** Auth settings; defaults to ADMIN_PASSWORD / SESSION_SECRET from the environment. */
  authCfg?: AuthConfig;
  /** Called after every successful write (kicks Google Calendar push + notifications). */
  onChange?: () => void;
  /** Service-account email when Google Calendar push is configured. */
  gcalEmail?: string | null;
  notify?: Notifier;
  reporter?: Reporter;
  aiEnabled?: boolean;
}

export function createApp(db: DB, {
  authCfg, onChange = () => {}, gcalEmail = null, notify = createNotifier(db),
  reporter = createReporter(), aiEnabled = aiAvailable(),
}: AppOptions = {}) {
  const audit = (req: Request, action: string, status: number) => {
    run(db, 'INSERT INTO audit_log (ip, action, status) VALUES (?, ?, ?)', req.ip || '', action, status);
  };
  const getEpoch = () => Number(one<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'session_epoch'")?.value || 0);
  const auth = makeAuth(authCfg ?? authConfig(), { getEpoch, audit });
  const secure = process.env.NODE_ENV === 'production';
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.use(express.json({ limit: '100kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); // family/booking links carry secrets in the URL
    res.setHeader('X-Frame-Options', 'DENY');
    // Only our own scripts/styles may run; blocks injected scripts even if an XSS bug slipped in.
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
      "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'",
      "form-action 'self'", "frame-ancestors 'none'",
    ].join('; '));
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // CSRF defence: a write must be JSON or carry our custom header. Other websites can only
  // send those with a CORS preflight, which this API never approves. (Also SameSite=Lax cookies.)
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const json = (req.headers['content-type'] || '').startsWith('application/json');
    if (json || req.headers['x-requested-with'] === 'tutoring-web') return next();
    res.status(415).json({ error: 'Send requests as JSON' });
  });

  // Audit every admin change (after the response, so the status is known).
  app.use('/api/admin', (req, res, next) => {
    if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode !== 401) audit(req, `${req.method} ${req.originalUrl.split('?')[0]}`, res.statusCode); });
    next();
  });

  app.post('/api/auth/login', auth.login);
  app.post('/api/auth/logout', auth.logout);
  app.get('/api/auth/me', (req, res) => res.json({ admin: auth.isAuthed(req) }));
  // After any successful write, kick the Google Calendar push so it lands within seconds.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) setImmediate(onChange); });
    next();
  });
  app.use('/api/public', publicRoutes(db, notify));
  app.use('/api/admin', auth.requireAdmin, adminRoutes(db, { gcalEmail, onChange, notify, reporter, aiEnabled }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => res.sendFile(join(dist, 'index.html')));
  }

  app.use((err: Error & { status?: number; expose?: boolean; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500 && !err.expose) console.error(err);
    // 5xx messages are hidden unless the error is marked safe to show (e.g. "AI service busy").
    res.status(status).json({ error: status >= 500 && !err.expose ? 'Something went wrong' : err.message });
  });
  return app;
}

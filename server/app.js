import express from 'express';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authConfig, makeAuth } from './auth.js';
import adminRoutes from './routes/admin.js';
import publicRoutes from './routes/public.js';
import { createNotifier } from './lib/notify.js';

export function createApp(db, {
  auth = makeAuth(authConfig()), onChange = () => {}, gcalEmail = null, notify = createNotifier(db),
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.use(express.json({ limit: '100kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); // family/booking links carry secrets in the URL
    res.setHeader('X-Frame-Options', 'DENY');
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
  app.use('/api/admin', auth.requireAdmin, adminRoutes(db, { gcalEmail, onChange, notify }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => res.sendFile(join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });
  return app;
}

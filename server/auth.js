import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

const COOKIE = 'tt_admin';
const MAX_AGE_S = 60 * 60 * 24 * 30;

export function authConfig() {
  const prod = process.env.NODE_ENV === 'production';
  let password = process.env.ADMIN_PASSWORD;
  let secret = process.env.SESSION_SECRET;
  if (prod && (!password || !secret)) {
    throw new Error('ADMIN_PASSWORD and SESSION_SECRET must be set in production');
  }
  if (!password) {
    password = 'changeme';
    console.warn('[auth] ADMIN_PASSWORD not set; using "changeme" (dev only)');
  }
  if (!secret) secret = randomBytes(32).toString('hex');
  return { password, secret, secure: prod };
}

const sign = (secret, payload) => createHmac('sha256', secret).update(payload).digest('base64url');

const safeEq = (a, b) => {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
};

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function makeAuth(cfg) {
  const attempts = new Map(); // ip -> { n, reset }

  function isAuthed(req) {
    const v = parseCookies(req.headers.cookie)[COOKIE];
    if (!v) return false;
    const [exp, mac] = v.split('.');
    if (!exp || !mac || Number(exp) < Date.now() / 1000) return false;
    return safeEq(mac, sign(cfg.secret, `admin.${exp}`));
  }

  function login(req, res) {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const a = attempts.get(ip) || { n: 0, reset: now + 15 * 60000 };
    if (now > a.reset) { a.n = 0; a.reset = now + 15 * 60000; }
    if (a.n >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    a.n++;
    attempts.set(ip, a);
    if (!safeEq(req.body?.password ?? '', cfg.password)) {
      return res.status(401).json({ error: 'Wrong password' });
    }
    attempts.delete(ip);
    const exp = Math.floor(now / 1000) + MAX_AGE_S;
    res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(cfg.secret, `admin.${exp}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${cfg.secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  }

  function logout(_req, res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  }

  const requireAdmin = (req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: 'Not logged in' }));

  return { isAuthed, login, logout, requireAdmin };
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = (msg) => new HttpError(400, msg);
export const notFound = (what = 'Not found') => new HttpError(404, what);

export const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const int = (v, fallback = null) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.trunc(Number(v)) : fallback);
export const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// Tiny fixed-window rate limiter keyed by IP.
export function rateLimit({ max, windowMs }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const h = hits.get(key);
    if (!h || now > h.reset) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max) return res.status(429).json({ error: 'Too many requests, please try again later.' });
    if (hits.size > 10000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    next();
  };
}

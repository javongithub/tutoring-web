import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class HttpError extends Error {
  status: number;
  /** Show the message to the client even for 5xx (it's safe and useful). */
  expose: boolean;
  constructor(status: number, message: string, expose = false) {
    super(message);
    this.status = status;
    this.expose = expose;
  }
}
export const bad = (msg: string): HttpError => new HttpError(400, msg);
export const notFound = (what = 'Not found'): HttpError => new HttpError(404, what);

/** Trimmed, length-capped string ('' for anything that isn't a string). */
export const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** Integer, or `fallback` for anything that isn't a finite number. */
export function int(v: unknown): number | null;
export function int<T>(v: unknown, fallback: T): number | T;
export function int(v: unknown, fallback: unknown = null): unknown {
  return v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback;
}
/** SQLite-style boolean: 1 or 0. */
export const bool = (v: unknown): 0 | 1 => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
export const isEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/** Tiny fixed-window rate limiter keyed by IP. */
export function rateLimit({ max, windowMs }: { max: number; windowMs: number }): RequestHandler {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const h = hits.get(key);
    if (!h || now > h.reset) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max) {
      res.status(429).json({ error: 'Too many requests, please try again later.' });
      return;
    }
    if (hits.size > 10000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    next();
  };
}

// Shared test setup: an app on a random port with an in-memory database, plus a small
// fetch wrapper that remembers the admin cookie.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type DB, openDb } from '../db.ts';
import { type AppOptions, createApp } from '../app.ts';

// Response bodies are dynamic JSON; `any` keeps test assertions readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
export interface Res { status: number; body: Json; headers: Headers }

export class Harness {
  db: DB;
  base = '';
  cookie = '';
  private server: Server | null = null;
  private opts: Omit<AppOptions, 'authCfg'>;

  constructor(db: DB = openDb(':memory:'), opts: Omit<AppOptions, 'authCfg'> = {}) {
    this.db = db;
    this.opts = opts;
  }

  async start(): Promise<this> {
    const app = createApp(this.db, { authCfg: { password: 'pw', secret: 's', secure: false }, ...this.opts });
    await new Promise<void>((resolve) => { this.server = app.listen(0, () => resolve()); });
    this.base = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  /** JSON request; sends the admin cookie unless `auth` is false. */
  call = async (method: string, path: string, body?: unknown, auth: boolean | { auth: boolean } = true): Promise<Res> => {
    const withAuth = typeof auth === 'boolean' ? auth : auth.auth;
    const res = await fetch(this.base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(withAuth && this.cookie ? { cookie: this.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: Json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };

  async login(password = 'pw'): Promise<Res> {
    const r = await this.call('POST', '/api/auth/login', { password }, false);
    const set = r.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return r;
  }

  close(): void { this.server?.close(); }
}

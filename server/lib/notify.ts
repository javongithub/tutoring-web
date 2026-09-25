// Email + phone-push notifications.
//
// Email goes out over SMTP (free with a Gmail app password; see README). Phone push goes
// through ntfy (https://ntfy.sh): install the free app, subscribe to your private topic,
// and new requests show up on your lock screen within seconds. No SMS fees.
//
// Everything is queued in the `outbox` table first, so a slow or failing mail server
// never breaks a booking, and failed sends are retried.
import { type DB, all, getSettings, one, run } from '../db.ts';
import type { OutboxRow, SessionRow } from '../types.ts';
import { addDays, fmtWhen, nowLocal, today } from './time.ts';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  from: string;
}
export interface MailMessage { from?: string; to: string; subject: string; text: string }
export type SendMail = (m: MailMessage) => Promise<unknown>;
interface NotifyOptions { path?: string; reqOrigin?: string; force?: boolean }

export interface Notifier {
  emailEnabled: boolean;
  /** Public base URL used in links, e.g. "https://34-1-2-3.sslip.io". */
  base(reqOrigin?: string): string;
  /** Alert the tutor: phone push (if set up) + email (if set up). */
  tutor(subject: string, body: string, opts?: NotifyOptions): void;
  /** Email a family (if they have an address and family emails are on, or `force`). */
  family(email: string | null | undefined, subject: string, body: string, opts?: NotifyOptions): void;
}

/** A session row plus who it's for and how to reach them. */
export interface SessionContext extends SessionRow {
  who: string;
  family_email: string | null;
  portal_token: string | null;
}

const MAX_ATTEMPTS = 5;

export function smtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  const port = Number(env.SMTP_PORT || 465);
  return {
    host: env.SMTP_HOST, port, secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    from: env.SMTP_FROM || env.SMTP_USER,
  };
}

export function createNotifier(
  db: DB,
  { smtp = smtpConfig(), origin = () => process.env.PUBLIC_URL || '' }: { smtp?: Pick<SmtpConfig, 'from'> | null; origin?: () => string } = {},
): Notifier {
  const ins = db.prepare('INSERT INTO outbox (channel, to_addr, subject, body, link) VALUES (?, ?, ?, ?, ?)');
  const base = (reqOrigin?: string): string => (getSettings(db).public_url || origin() || reqOrigin || '').replace(/\/$/, '');

  const n: Notifier = {
    emailEnabled: !!smtp,
    base,

    // You: email (if an address is set) + phone push (if an ntfy topic is set).
    tutor(subject, body, { path = '/admin', reqOrigin } = {}) {
      const st = getSettings(db);
      const link = base(reqOrigin) + path;
      if (st.ntfy_url) ins.run('push', st.ntfy_url, subject, body, link);
      if (smtp && st.notify_email) ins.run('email', st.notify_email, subject, `${body}\n\nOpen: ${link}`, link);
    },

    // A family. Only if they gave an email and family emails are on.
    // `force` = the family explicitly asked for this email (e.g. waitlist), send even if
    // routine family emails are turned off.
    family(email, subject, body, { path = '', reqOrigin, force = false } = {}) {
      const st = getSettings(db);
      if (!smtp || (!st.email_families && !force) || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
      const link = path ? base(reqOrigin) + path : '';
      const sign = st.tutor_name ? `\n\n— ${st.tutor_name}` : '';
      ins.run('email', email, subject, `${body}${link ? `\n\n${link}` : ''}${sign}`, link);
    },
  };
  return n;
}

// Contact + link details for a session row (joins students). Used by route hooks.
export function sessionContext(db: DB, sessionId: number): SessionContext {
  const row = one<SessionContext>(db,
    `SELECT s.*, COALESCE(st.name, s.requester_student) AS who, COALESCE(NULLIF(st.email, ''), s.requester_email) AS family_email,
            st.portal_token FROM sessions s LEFT JOIN students st ON st.id = s.student_id WHERE s.id = ?`,
    sessionId);
  if (!row) throw new Error(`Session ${sessionId} not found`);
  return row;
}

export const when = (s: Pick<SessionRow, 'start_at' | 'end_at'>): string => fmtWhen(s.start_at, s.end_at);

// Send whatever is queued. `sendMail({from,to,subject,text})` and `fetchImpl` are injectable for tests.
export async function flushOutbox(
  db: DB,
  { smtp = smtpConfig(), sendMail, fetchImpl = fetch }: { smtp?: SmtpConfig | Pick<SmtpConfig, 'from'> | null; sendMail?: SendMail; fetchImpl?: typeof fetch } = {},
): Promise<{ sent: number; pending: number }> {
  let transport = sendMail;
  if (!transport && smtp && 'host' in smtp) {
    const { default: nodemailer } = await import('nodemailer');
    const t = nodemailer.createTransport(smtp);
    transport = (m) => t.sendMail(m);
  }
  const rows = all<OutboxRow>(db, 'SELECT * FROM outbox WHERE sent_at IS NULL AND attempts < ? ORDER BY id LIMIT 50', MAX_ATTEMPTS);
  const ok = db.prepare("UPDATE outbox SET sent_at = datetime('now'), attempts = attempts + 1, last_error = '' WHERE id = ?");
  const fail = db.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?');
  let sent = 0;
  for (const m of rows) {
    try {
      if (m.channel === 'push') await sendPush(m, fetchImpl);
      else {
        if (!transport) throw new Error('Email not configured (set SMTP_* on the server)');
        await transport({ from: smtp?.from, to: m.to_addr, subject: m.subject, text: m.body });
      }
      ok.run(m.id);
      sent++;
    } catch (e) {
      fail.run((e instanceof Error ? e.message : String(e)).slice(0, 500), m.id);
    }
  }
  return { sent, pending: rows.length - sent };
}

// ntfy JSON publish: POST to the server root with the topic in the body (keeps
// non-ASCII titles like "—" out of HTTP headers).
async function sendPush(m: OutboxRow, fetchImpl: typeof fetch): Promise<void> {
  const u = new URL(m.to_addr);
  const topic = u.pathname.replace(/^\/+|\/+$/g, '');
  if (!topic) throw new Error('ntfy URL needs a topic, e.g. https://ntfy.sh/your-secret-topic');
  const res = await fetchImpl(`${u.origin}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      topic, title: m.subject, message: m.body, tags: ['books'],
      ...(m.link ? { click: m.link, actions: [{ action: 'view', label: 'Open', url: m.link }] } : {}),
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ntfy returned HTTP ${res.status}`);
}

// Evening-before reminder emails to families. Each session is reminded at most once.
export function queueReminders(db: DB, notifier: Notifier): number {
  const st = getSettings(db);
  if (!st.reminders) return 0;
  const now = nowLocal();
  if (Number(now.slice(11, 13)) < st.reminder_hour) return 0;
  const tomorrow = addDays(today(), 1);
  const rows = all<{ id: number }>(db,
    `SELECT s.id FROM sessions s WHERE s.status = 'confirmed' AND s.reminded = 0
       AND s.start_at >= ? AND s.start_at < ?`,
    `${tomorrow}T00:00`, `${addDays(tomorrow, 1)}T00:00`);
  for (const { id } of rows) {
    const s = sessionContext(db, id);
    notifier.family(s.family_email, `Reminder: ${s.who}'s session tomorrow`,
      `Hi! Quick reminder: ${s.who} has tutoring ${when(s)}.\n\nNeed to change it? Use your family page:`,
      { path: s.portal_token ? `/family/${s.portal_token}` : `/booking/${s.token}` });
    run(db, 'UPDATE sessions SET reminded = 1 WHERE id = ?', id);
  }
  return rows.length;
}

// Push app sessions to the tutor's Google Calendar in near real time.
//
// Setup (no OAuth screen needed): create a Google Cloud service account, download its
// JSON key, set GOOGLE_SERVICE_ACCOUNT_JSON (the JSON itself or a path to it), then in
// Google Calendar → Settings → Share with specific people, add the service account's
// email with "Make changes to events". Put your calendar ID (your Gmail address) in
// the app's Settings page.
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { getSettings } from '../db.js';
import { addDays, TZ, today } from './time.js';

const API = 'https://www.googleapis.com/calendar/v3';
export const APP_MARKER = 'tutoring-app:session:';

export function loadServiceAccount(raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  if (!raw) return null;
  const text = raw.trim().startsWith('{') ? raw : existsSync(raw) ? readFileSync(raw, 'utf8') : null;
  if (!text) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is neither JSON nor a readable file');
  const j = JSON.parse(text);
  if (!j.client_email || !j.private_key) throw new Error('Service account JSON is missing client_email/private_key');
  return { email: j.client_email, key: j.private_key };
}

export function createGcal({ account, fetchImpl = fetch }) {
  let cached = null;

  async function token() {
    if (cached && cached.exp > Date.now() + 60000) return cached.value;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: account.email, scope: 'https://www.googleapis.com/auth/calendar.events',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(account.key).toString('base64url');
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`Google auth failed: ${j.error_description || j.error || res.status}`);
    cached = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return cached.value;
  }

  async function api(method, path, body) {
    const res = await fetchImpl(API + path, {
      method,
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 || res.status === 410) return { gone: true };
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(`Google Calendar ${method} failed: ${j.error?.message || res.status}`);
    }
    return res.status === 204 ? {} : res.json();
  }

  return { api, email: account.email };
}

const KEEP = ['pending', 'confirmed', 'completed', 'no_show'];

export function eventBody(s) {
  const who = s.student_name || s.requester_student || 'New student';
  const lines = [
    s.status === 'pending' ? 'Booking request — approve it in the tutoring app.' : '',
    s.parent_name || s.requester_name ? `Parent: ${s.parent_name || s.requester_name}` : '',
    s.subject ? `Subject: ${s.subject}` : '',
    s.student_next_plan ? `Plan for this session: ${s.student_next_plan}` : '',
    '', APP_MARKER + s.id,
  ].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''));
  return {
    summary: `${s.status === 'pending' ? '[REQUEST] ' : ''}${who} Tutoring`,
    description: lines.join('\n'),
    start: { dateTime: `${s.start_at}:00`, timeZone: TZ },
    end: { dateTime: `${s.end_at}:00`, timeZone: TZ },
    colorId: s.status === 'pending' ? '5' : '9',
  };
}

// Push every session marked dirty within the sync window. Safe to call often.
export async function pushDirty(db, gcal) {
  const { gcal_calendar_id: cal } = getSettings(db);
  if (!gcal || !cal) return { pushed: 0 };
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const rows = db.prepare(
    `SELECT s.*, st.name AS student_name, st.parent_name, st.subject, st.next_plan AS student_next_plan
       FROM sessions s LEFT JOIN students st ON st.id = s.student_id
      WHERE s.gcal_dirty = 1 AND (s.gcal_event_id IS NOT NULL OR (s.start_at >= ? AND s.start_at < ?))
      ORDER BY s.start_at LIMIT 100`,
  ).all(`${addDays(today(), -7)}T00:00`, `${addDays(today(), 70)}T00:00`);
  const done = db.prepare('UPDATE sessions SET gcal_dirty = 0, gcal_event_id = ? WHERE id = ?');
  const calPath = `/calendars/${encodeURIComponent(cal)}/events`;
  let pushed = 0;
  try {
    for (const s of rows) {
      if (!KEEP.includes(s.status)) {
        if (s.gcal_event_id) await gcal.api('DELETE', `${calPath}/${s.gcal_event_id}`);
        done.run(null, s.id);
      } else if (s.gcal_event_id) {
        const r = await gcal.api('PATCH', `${calPath}/${s.gcal_event_id}`, eventBody(s));
        done.run(r.gone ? null : s.gcal_event_id, s.id);
        if (r.gone) db.prepare('UPDATE sessions SET gcal_dirty = 1 WHERE id = ?').run(s.id); // recreate next pass
      } else {
        const r = await gcal.api('POST', calPath, eventBody(s));
        done.run(r.id, s.id);
      }
      pushed++;
    }
    set.run('gcal_error', '');
    if (pushed) set.run('gcal_synced_at', new Date().toISOString());
  } catch (e) {
    set.run('gcal_error', e.message);
    throw e;
  }
  return { pushed };
}

// Fallback without Google setup: an iCal feed Google Calendar can subscribe to
// ("Other calendars → From URL"). Google refreshes these only every several hours.
export function buildFeed(db) {
  const rows = db.prepare(
    `SELECT s.*, st.name AS student_name, st.parent_name, st.subject, st.next_plan AS student_next_plan
       FROM sessions s LEFT JOIN students st ON st.id = s.student_id
      WHERE s.status IN ('pending','confirmed','completed','no_show') AND s.start_at >= ? AND s.start_at < ?`,
  ).all(`${addDays(today(), -30)}T00:00`, `${addDays(today(), 70)}T00:00`);
  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const dt = (s) => s.replace(/[-:]/g, '') + '00';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tutoring-web//EN', 'X-WR-CALNAME:Tutoring', `X-WR-TIMEZONE:${TZ}`];
  for (const s of rows) {
    const e = eventBody(s);
    out.push('BEGIN:VEVENT', `UID:session-${s.id}@tutoring-web`, `DTSTAMP:${stamp}`,
      `DTSTART;TZID=${TZ}:${dt(s.start_at)}`, `DTEND;TZID=${TZ}:${dt(s.end_at)}`,
      `SUMMARY:${esc(e.summary)}`, `DESCRIPTION:${esc(e.description)}`, 'END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n');
}

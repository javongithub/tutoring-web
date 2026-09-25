import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { makeAuth } from '../auth.js';
import { createNotifier } from '../lib/notify.js';
import { announceOpenings } from '../lib/waitlist.js';
import { addDays, today, weekday } from '../lib/time.js';

let server; let base; let db; let cookie = ''; let notify;
const call = async (method, path, body, auth = true) => {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(auth && cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
const mails = (to) => db.prepare("SELECT * FROM outbox WHERE channel = 'email' AND to_addr = ? ORDER BY id").all(to);
const day = addDays(today(), 3);

before(async () => {
  db = openDb(':memory:');
  // Availability only 15:00–17:00 on `day`, fully booked by one student.
  db.prepare('INSERT INTO availability (weekday, start_time, end_time) VALUES (?, ?, ?)').run(weekday(day), '15:00', '17:00');
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'email_families'").run(); // waitlist mail must still go out
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'booking_weeks_ahead'").run(); // only this one day in range
  notify = createNotifier(db, { smtp: { from: 'me@x.com' }, origin: () => 'https://t.example' });
  const app = createApp(db, { auth: makeAuth({ password: 'pw', secret: 's', secure: false }), notify });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = (await call('POST', '/api/auth/login', { password: 'pw' })).headers.get('set-cookie').split(';')[0];
});
after(() => server.close());

let sessionId; let wlToken;
test('join waitlist (with honeypot + validation) and get a confirmation', async () => {
  const st = (await call('POST', '/api/admin/students', { name: 'Busy Kid' })).body;
  sessionId = (await call('POST', '/api/admin/sessions', { student_id: st.id, start_at: `${day}T15:00`, duration_min: 120 })).body.id;
  assert.equal(announceOpenings(db, notify).announced, 0, 'nothing open');

  assert.equal((await call('POST', '/api/public/waitlist', { parent_name: 'P', student_name: 'S', email: 'bad' }, false)).status, 400);
  const bot = await call('POST', '/api/public/waitlist', { parent_name: 'Bot', student_name: 'Bot', email: 'bot@x.com', website: 'spam' }, false);
  assert.equal(bot.status, 201);
  const r = await call('POST', '/api/public/waitlist', {
    parent_name: 'Ms. W', student_name: 'Wanda', email: 'W@Example.com', weekdays: [weekday(day)],
  }, false);
  assert.equal(r.status, 201);
  wlToken = r.body.token;
  const other = await call('POST', '/api/public/waitlist', {
    parent_name: 'Mr. O', student_name: 'Otto', email: 'o@example.com', weekdays: [(weekday(day) + 1) % 7],
  }, false);
  assert.equal(other.status, 201);
  const list = (await call('GET', '/api/admin/waitlist')).body;
  assert.deepEqual(list.map((w) => w.student_name).sort(), ['Otto', 'Wanda'], 'bot dropped');
  assert.match(mails('w@example.com')[0].subject, /on the waitlist for Wanda/);
});

test('a cancellation announces the opening once, only to matching days', async () => {
  await call('POST', `/api/admin/sessions/${sessionId}/cancel`, { by: 'client' });
  const r = announceOpenings(db, notify);
  assert.equal(r.announced, 3, '60-min slots at 15:00, 15:30, 16:00');
  const m = mails('w@example.com').at(-1);
  assert.match(m.subject, /tutoring slots opened|A tutoring slot opened/);
  assert.match(m.body, /https:\/\/t\.example\/\?week=/);
  assert.match(m.body, new RegExp(`/waitlist/${wlToken}`));
  assert.equal(mails('o@example.com').length, 1, 'Otto (other weekday) only got the join confirmation');
  assert.equal(announceOpenings(db, notify).announced, 0, 'not announced twice');

  // Slot gets taken, then frees up again -> announced again.
  await call('POST', `/api/admin/sessions/${sessionId}/reopen`);
  assert.equal(announceOpenings(db, notify).announced, 0);
  await call('POST', `/api/admin/sessions/${sessionId}/cancel`, { by: 'tutor', notify: 0 });
  assert.ok(announceOpenings(db, notify).announced > 0, 're-opened slot announced again');
});

test('booking with the same email takes them off the waitlist; leave link works', async () => {
  const slot = (await call('GET', `/api/public/week?start=${day}`, null, false)).body.slots.find((s) => s.start_at.startsWith(day));
  await call('POST', '/api/public/requests', { start_at: slot.start_at, parent_name: 'Ms. W', student_name: 'Wanda', email: 'w@example.com' }, false);
  const w = (await call('GET', '/api/admin/waitlist')).body.find((x) => x.student_name === 'Wanda');
  assert.equal(w.status, 'booked');
  const o = (await call('GET', '/api/admin/waitlist')).body.find((x) => x.student_name === 'Otto');
  const left = await call('POST', `/api/public/waitlist/${o.token}/leave`, {}, false);
  assert.equal(left.status, 200);
  assert.equal((await call('GET', `/api/public/waitlist/${o.token}`, null, false)).body.status, 'removed');
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { all, openDb } from '../db.ts';
import { Harness, type Json } from './harness.ts';
import { createNotifier, flushOutbox, queueReminders } from '../lib/notify.ts';
import { addDays, today, weekday } from '../lib/time.ts';

const db = openDb(':memory:');
const smtp = { from: 'me@gmail.com' };
const h = new Harness(db, { notify: createNotifier(db, { smtp, origin: () => 'https://tutor.example' }) });
const { call } = h;
const outbox = () => all<Json>(db, 'SELECT * FROM outbox ORDER BY id');
const day = addDays(today(), 3);

before(async () => {
  db.prepare('INSERT INTO availability (weekday, start_time, end_time) VALUES (?, ?, ?)').run(weekday(day), '15:00', '20:00');
  db.prepare("UPDATE settings SET value = 'me@gmail.com' WHERE key = 'notify_email'").run();
  db.prepare("UPDATE settings SET value = 'https://ntfy.sh/tutor-test-123' WHERE key = 'ntfy_url'").run();
  await h.start();
  await h.login();
});
after(() => h.close());

let token: Json;
test('booking request alerts tutor (push + email) and emails the family a receipt', async () => {
  const r = await call('POST', '/api/public/requests', {
    start_at: `${day}T16:00`, parent_name: 'Ms. P', student_name: 'Kid', email: 'parent@example.com', message: 'Algebra',
  }, false);
  token = r.body.token;
  const rows = outbox();
  const push = rows.find((m: Json) => m.channel === 'push');
  assert.equal(push.subject, 'New booking request: Kid');
  assert.match(push.body, /parent@example.com/);
  assert.equal(push.link, 'https://tutor.example/admin');
  assert.ok(rows.find((m: Json) => m.channel === 'email' && m.to_addr === 'me@gmail.com'));
  const fam = rows.find((m: Json) => m.to_addr === 'parent@example.com');
  assert.match(fam.subject, /Request received/);
  assert.ok(fam.body.includes(`https://tutor.example/booking/${token}`));
});

test('confirming emails the family their family-page link', async () => {
  db.prepare('DELETE FROM outbox').run();
  const id = (await call('GET', '/api/admin/dashboard')).body.pending[0].id;
  await call('POST', `/api/admin/sessions/${id}/confirm`, {});
  const [m] = outbox();
  assert.equal(m.to_addr, 'parent@example.com');
  assert.match(m.subject, /^Confirmed: Kid/);
  assert.match(m.body, /https:\/\/tutor\.example\/family\//);
});

test('family change request alerts tutor; decision emails family', async () => {
  db.prepare('DELETE FROM outbox').run();
  await call('POST', `/api/public/booking/${token}/change`, { kind: 'reschedule', new_start_at: `${day}T18:00`, reason: 'Practice' }, false);
  const alert = outbox().find((m: Json) => m.channel === 'push');
  assert.match(alert.subject, /^Move request: Kid/);
  assert.match(alert.body, /Practice/);
  db.prepare('DELETE FROM outbox').run();
  const cid = (await call('GET', '/api/admin/dashboard')).body.changes[0].id;
  await call('POST', `/api/admin/changes/${cid}/approve`, {});
  const [m] = outbox();
  assert.match(m.subject, /^Move approved: Kid is now .*6pm/);
});

test('tutor cancel emails family; recording a family cancel does not', async () => {
  const s = (await call('GET', `/api/admin/sessions?from=${day}&to=${addDays(day, 1)}`)).body.sessions[0];
  db.prepare('DELETE FROM outbox').run();
  await call('POST', `/api/admin/sessions/${s.id}/cancel`, { by: 'client', reason: 'texted me' });
  assert.equal(outbox().length, 0);
  await call('POST', `/api/admin/sessions/${s.id}/reopen`);
  await call('POST', `/api/admin/sessions/${s.id}/cancel`, { by: 'tutor', reason: 'Midterm' });
  assert.match(outbox()[0].subject, /^Cancelled: Kid/);
});

test('outbox worker: sends email + ntfy JSON, retries failures', async () => {
  db.prepare('DELETE FROM outbox').run();
  const notify = createNotifier(db, { smtp, origin: () => 'https://tutor.example' });
  notify.tutor('Move request: Kid — late', 'body', {});
  const mails: Json[] = []; const pushes: { url: string; body: Json }[] = [];
  let failNext = true;
  const fetchImpl = (async (url: string, opts: { body: string }) => { pushes.push({ url, body: JSON.parse(opts.body) }); return new Response('{}'); }) as unknown as typeof fetch;
  const sendMail = async (m: Json) => { if (failNext) { failNext = false; throw new Error('SMTP down'); } mails.push(m); };
  let r = await flushOutbox(db, { smtp, sendMail, fetchImpl });
  assert.equal(r.sent, 1);
  assert.equal(pushes[0].url, 'https://ntfy.sh/');
  assert.equal(pushes[0].body.topic, 'tutor-test-123');
  assert.equal(pushes[0].body.title, 'Move request: Kid — late', 'non-ASCII title survives (JSON body, not header)');
  assert.equal(pushes[0].body.click, 'https://tutor.example/admin');
  assert.equal(outbox().find((m: Json) => m.channel === 'email').last_error, 'SMTP down');
  r = await flushOutbox(db, { smtp, sendMail, fetchImpl });
  assert.equal(r.sent, 1);
  assert.equal(mails[0].to, 'me@gmail.com');
  assert.equal(outbox().filter((m: Json) => !m.sent_at).length, 0);
});

test('reminders go out once, only when enabled', () => {
  db.prepare('DELETE FROM outbox').run();
  const notify = createNotifier(db, { smtp, origin: () => 'https://tutor.example' });
  const st = db.prepare("INSERT INTO students (name, email, portal_token) VALUES ('Rem', 'rem@example.com', 'tok-rem')").run().lastInsertRowid;
  db.prepare("INSERT INTO sessions (student_id, start_at, end_at, token) VALUES (?, ?, ?, 'tk-rem')")
    .run(st, `${addDays(today(), 1)}T16:00`, `${addDays(today(), 1)}T17:00`);
  assert.equal(queueReminders(db, notify), 0, 'off by default');
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'reminders'").run();
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'reminder_hour'").run();
  assert.equal(queueReminders(db, notify), 1);
  assert.equal(queueReminders(db, notify), 0, 'not twice');
  const m = outbox().find((x: Json) => x.to_addr === 'rem@example.com');
  assert.match(m.subject, /Reminder: Rem's session tomorrow/);
  assert.match(m.body, /family\/tok-rem/);
});

test('without SMTP configured, nothing is queued for email', () => {
  db.prepare('DELETE FROM outbox').run();
  const notify = createNotifier(db, { smtp: null });
  notify.family('x@example.com', 's', 'b');
  notify.tutor('s', 'b');
  assert.deepEqual(outbox().map((m: Json) => m.channel), ['push']);
});

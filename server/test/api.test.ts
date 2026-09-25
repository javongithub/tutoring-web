import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { one } from '../db.ts';
import { Harness, type Json } from './harness.ts';
import { addDays, today, weekday, weekStart } from '../lib/time.ts';
import { expandIcs, parseTutoringTitle } from '../lib/ics.ts';

const h = new Harness();
const { db, call } = h;

// A day at least 3 days out so the 24h notice rule never interferes.
const day = addDays(today(), 3);
const wd = weekday(day);

before(async () => {
  db.prepare('INSERT INTO availability (weekday, start_time, end_time) VALUES (?, ?, ?)').run(wd, '15:00', '20:00');
  db.prepare('INSERT INTO blocks (label, weekday, start_time, end_time) VALUES (?, ?, ?, ?)').run('WRITING 139W secret', wd, '18:00', '19:00');
  await h.start();
});
after(() => h.close());

test('admin API requires login', async () => {
  assert.equal((await call('GET', '/api/admin/dashboard', null, { auth: false })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { password: 'nope' })).status, 401);
  const ok = await call('POST', '/api/auth/login', { password: 'pw' });
  assert.equal(ok.status, 200);
  h.cookie = ok.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await call('GET', '/api/admin/dashboard')).status, 200);
});

let alex: Json;
test('weekly schedule generates sessions', async () => {
  alex = (await call('POST', '/api/admin/students', { name: 'Alex', parent_name: 'Pat' })).body;
  assert.equal(alex.rate_cents, 3000);
  const rule = await call('POST', `/api/admin/students/${alex.id}/rules`, { weekday: wd, start_time: '15:00', duration_min: 60 });
  assert.equal(rule.status, 201);
  const { body } = await call('GET', `/api/admin/sessions?from=${day}&to=${addDays(day, 1)}`);
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].student_name, 'Alex');
});

test('public week hides names and details', async () => {
  const { body } = await call('GET', `/api/public/week?start=${day}`, null, { auth: false });
  const text = JSON.stringify(body);
  assert.ok(!text.includes('Alex'), 'other student name leaked');
  assert.ok(!text.includes('WRITING'), 'block label leaked');
  const labels = body.occupied.filter((o: Json) => o.start_at.startsWith(day)).map((o: Json) => o.label).sort();
  assert.deepEqual(labels, ['Busy', 'Other student']);
  const starts = body.slots.filter((s: Json) => s.start_at.startsWith(day)).map((s: Json) => s.start_at.slice(11));
  assert.ok(!starts.includes('15:00') && !starts.includes('18:00') && !starts.includes('17:30'));
  assert.ok(starts.includes('16:00') && starts.includes('19:00'));
});

test('family portal shows own sessions by name, others anonymised', async () => {
  const other = (await call('POST', '/api/admin/students', { name: 'Jordan' })).body;
  await call('POST', '/api/admin/sessions', { student_id: other.id, start_at: `${day}T16:00`, duration_min: 60 });
  const { body } = await call('GET', `/api/public/week?start=${day}&family=${alex.portal_token}`, null, { auth: false });
  const onDay = body.occupied.filter((o: Json) => o.start_at.startsWith(day));
  assert.deepEqual(onDay.map((o: Json) => o.label), ['Alex', 'Other student', 'Busy']);
  assert.ok(!JSON.stringify(body).includes('Jordan'));
  assert.equal((await call('GET', '/api/public/week?family=bogus', null, { auth: false })).status, 404);
});

let reqToken: string;
test('booking request -> tutor confirms -> new student created', async () => {
  const bad = await call('POST', '/api/public/requests', {
    start_at: `${day}T15:00`, parent_name: 'Ms. P', student_name: 'Kid', email: 'p@example.com',
  }, { auth: false });
  assert.equal(bad.status, 400, 'booked slot must be rejected');
  const r = await call('POST', '/api/public/requests', {
    start_at: `${day}T19:00`, parent_name: 'Ms. P', student_name: 'Kid', email: 'p@example.com', message: 'Algebra help',
  }, { auth: false });
  assert.equal(r.status, 201);
  reqToken = r.body.token;
  const dup = await call('POST', '/api/public/requests', {
    start_at: `${day}T19:00`, parent_name: 'X', student_name: 'Y', email: 'x@example.com',
  }, { auth: false });
  assert.equal(dup.status, 400, 'pending request must hold the slot');

  const dash = (await call('GET', '/api/admin/dashboard')).body;
  assert.equal(dash.pending.length, 1);
  const conf = await call('POST', `/api/admin/sessions/${dash.pending[0].id}/confirm`, {});
  assert.equal(conf.body.status, 'confirmed');
  assert.equal(conf.body.student_name, 'Kid');
  const status = (await call('GET', `/api/public/booking/${reqToken}`, null, { auth: false })).body;
  assert.equal(status.status, 'confirmed');
  assert.ok(status.family_token);
});

test('family cancel needs tutor approval', async () => {
  const req = await call('POST', `/api/public/booking/${reqToken}/change`, { kind: 'cancel', reason: 'Sick' }, { auth: false });
  assert.equal(req.status, 201);
  assert.equal(req.body.status, 'confirmed', 'nothing changes before approval');
  assert.equal(req.body.change_request.kind, 'cancel');
  const again = await call('POST', `/api/public/booking/${reqToken}/change`, { kind: 'cancel' }, { auth: false });
  assert.equal(again.status, 400, 'only one open request per session');

  const dash = (await call('GET', '/api/admin/dashboard')).body;
  assert.equal(dash.changes.length, 1);
  await call('POST', `/api/admin/changes/${dash.changes[0].id}/approve`, {});
  const after = (await call('GET', `/api/public/booking/${reqToken}`, null, { auth: false })).body;
  assert.equal(after.status, 'cancelled');
  assert.equal(after.last_decision.status, 'approved');

  const { body } = await call('GET', '/api/admin/cancellations');
  const row = body.rows.find((x: Json) => x.cancel_reason === 'Sick');
  assert.equal(row.cancelled_by, 'client');
  assert.equal(row.late_cancel, 0);
  assert.equal(body.by_student.find((x: Json) => x.name === 'Kid').client_cancels, 1);
  const week = (await call('GET', `/api/public/week?start=${day}`, null, { auth: false })).body;
  assert.ok(week.slots.some((s: Json) => s.start_at === `${day}T19:00`), 'cancelled slot opens back up');
});

test('family move request holds the new slot; approval moves one week of a weekly schedule', async () => {
  const fam = (await call('GET', `/api/public/family/${alex.portal_token}`, null, { auth: false })).body;
  const session = fam.upcoming.find((s: Json) => s.start_at === `${day}T15:00`);
  assert.ok(session.can_request_change);
  const taken = await call('POST', `/api/public/booking/${session.token}/change`,
    { kind: 'reschedule', new_start_at: `${day}T16:00` }, { auth: false });
  assert.equal(taken.status, 400, 'cannot move onto another student');
  const ok = await call('POST', `/api/public/booking/${session.token}/change`,
    { kind: 'reschedule', new_start_at: `${day}T19:00`, reason: 'Practice' }, { auth: false });
  assert.equal(ok.status, 201);
  let week = (await call('GET', `/api/public/week?start=${day}`, null, { auth: false })).body;
  assert.ok(!week.slots.some((s: Json) => s.start_at === `${day}T19:00`), 'requested slot is held');
  assert.ok(week.occupied.some((o: Json) => o.start_at === `${day}T15:00`), 'original still booked until approval');

  const dash = (await call('GET', '/api/admin/dashboard')).body;
  const decline = dash.changes[0];
  await call('POST', `/api/admin/changes/${decline.id}/decline`, { note: 'Can’t that day' });
  week = (await call('GET', `/api/public/week?start=${day}`, null, { auth: false })).body;
  assert.ok(week.slots.some((s: Json) => s.start_at === `${day}T19:00`), 'declined hold released');

  await call('POST', `/api/public/booking/${session.token}/change`, { kind: 'reschedule', new_start_at: `${day}T19:00` }, { auth: false });
  const c = (await call('GET', '/api/admin/dashboard')).body.changes[0];
  const ap = await call('POST', `/api/admin/changes/${c.id}/approve`, {});
  assert.equal(ap.status, 200);
  const { body } = await call('GET', `/api/admin/sessions?from=${day}&to=${addDays(day, 1)}&student_id=${alex.id}`);
  assert.deepEqual(body.sessions.map((s: Json) => s.start_at), [`${day}T19:00`], 'moved, and weekly rule did not regenerate 15:00');
});

test('logging a session records notes, next plan and $30', async () => {
  const past = addDays(today(), -2);
  const s = (await call('POST', '/api/admin/sessions', { student_id: alex.id, start_at: `${past}T15:00`, duration_min: 60 })).body;
  const done = await call('POST', `/api/admin/sessions/${s.id}/complete`, {
    topics: 'Unit circle', notes: 'Solid', next_plan: 'Inverse trig',
  });
  assert.equal(done.body.status, 'completed');
  const st = (await call('GET', `/api/admin/students/${alex.id}`)).body;
  assert.equal(st.student.next_plan, 'Inverse trig');
  assert.equal(st.stats.earned_cents, 3000);
  const log = (await call('GET', '/api/admin/log')).body;
  assert.equal(log.totals.earned_cents, 3000);
  assert.equal(log.totals.unpaid_cents, 3000);
  await call('POST', '/api/admin/sessions/mark-paid', { student_id: alex.id });
  assert.equal((await call('GET', '/api/admin/log')).body.totals.unpaid_cents, 0);
  const csv = await call('GET', '/api/admin/log.csv');
  assert.match(csv.body, /Unit circle/);
  const dash = (await call('GET', '/api/admin/dashboard')).body;
  assert.equal(dash.earnings.all_time.cents, 3000);
});

test('iCal feed: weekly recurrence, exdate, override, tutoring detection', () => {
  const mon = weekStart(today());
  const ymd = mon.replaceAll('-', '');
  const next = addDays(mon, 7).replaceAll('-', '');
  const tue = addDays(mon, 1).replaceAll('-', ''); // 01:30Z Tuesday = 6:30pm Monday Pacific
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Alex Tutoring (said on 8/26)',
    `DTSTART;TZID=America/Los_Angeles:${ymd}T153000`, `DTEND;TZID=America/Los_Angeles:${ymd}T163000`,
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', `EXDATE;TZID=America/Los_Angeles:${next}T153000`, 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'SUMMARY:FUSION (UCI)',
    `DTSTART:${tue}T013000Z`, `DTEND:${tue}T040000Z`, 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Alex Tutoring', `RECURRENCE-ID;TZID=America/Los_Angeles:${ymd}T153000`,
    `DTSTART;TZID=America/Los_Angeles:${ymd}T170000`, `DTEND;TZID=America/Los_Angeles:${ymd}T180000`, 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const ev = expandIcs(ics, mon, addDays(mon, 14));
  const alexTimes = ev.filter((e: Json) => e.uid === 'a').map((e: Json) => e.start_at);
  assert.deepEqual(alexTimes, [`${mon}T17:00`, `${addDays(mon, 2)}T15:30`, `${addDays(mon, 9)}T15:30`]);
  const fusion = ev.find((e: Json) => e.uid === 'b')!;
  assert.equal(fusion.start_at.slice(0, 10), mon);
  assert.ok(fusion.start_at.endsWith('T18:30'), `UTC converted to Pacific: ${fusion.start_at}`);
  assert.deepEqual(parseTutoringTitle('Casey Tutoring — Ms. Rivera (said on 9/8)'), { name: 'Casey', parent: 'Ms. Rivera' });
  assert.deepEqual(parseTutoringTitle('Tutoring with Sam Carter (said on 8/31)'), { name: 'Sam Carter', parent: '' });
  assert.equal(parseTutoringTitle('FUSION (UCI)'), null);
});

test('Google Calendar push: create, update on move, delete on cancel; no echo on pull', async () => {
  const { createGcal, pushDirty, APP_MARKER } = await import('../lib/gcal.ts');
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls: { method: string; url: string; body: Json }[] = [];
  const fake = (async (url: string, opts: RequestInit & { body?: string; method: string }) => {
    if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    calls.push({ method: opts.method, url, body: opts.body && JSON.parse(opts.body) });
    return new Response(opts.method === 'DELETE' ? null : JSON.stringify({ id: `ev${calls.length}` }), { status: opts.method === 'DELETE' ? 204 : 200 });
  }) as unknown as typeof fetch;
  const gcal = createGcal({ account: { email: 'sa@x.iam', key: String(privateKey.export({ type: 'pkcs8', format: 'pem' })) }, fetchImpl: fake });
  db.prepare("UPDATE settings SET value = 'me@gmail.com' WHERE key = 'gcal_calendar_id'").run();
  db.prepare('UPDATE sessions SET gcal_dirty = 0').run();
  const casey = (await call('POST', '/api/admin/students', { name: 'Casey' })).body;
  const s = (await call('POST', '/api/admin/sessions', { student_id: casey.id, start_at: `${day}T17:00`, duration_min: 60 })).body;
  await pushDirty(db, gcal);
  assert.equal(calls.at(-1)!.method, 'POST');
  assert.equal(calls.at(-1)!.body.summary, 'Casey Tutoring');
  assert.ok(calls.at(-1)!.body.description.includes(APP_MARKER + s.id));
  await call('PATCH', `/api/admin/sessions/${s.id}`, { start_at: `${day}T17:30` });
  await pushDirty(db, gcal);
  assert.equal(calls.at(-1)!.method, 'PATCH');
  assert.equal(calls.at(-1)!.body.start.dateTime, `${day}T17:30:00`);
  await call('POST', `/api/admin/sessions/${s.id}/cancel`, { by: 'tutor' });
  await pushDirty(db, gcal);
  assert.equal(calls.at(-1)!.method, 'DELETE');
  const n = calls.length;
  await pushDirty(db, gcal);
  assert.equal(calls.length, n, 'nothing dirty, nothing sent');
  const feed = await call('GET', `/api/public/feed/${one<Json>(db, "SELECT value FROM settings WHERE key='feed_token'")!.value}.ics`, null, { auth: false });
  assert.match(feed.body, /BEGIN:VCALENDAR/);
  assert.equal((await call('GET', '/api/public/feed/wrong.ics', null, { auth: false })).status, 404);
});

test('24-hour policy: late requests allowed only after acknowledging, flagged late', async () => {
  const soon = (await call('POST', '/api/admin/students', { name: 'Soon' })).body;
  const inFive = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(Date.now() + 5 * 3600000)).replace(', ', 'T');
  const s = (await call('POST', '/api/admin/sessions', { student_id: soon.id, start_at: inFive, duration_min: 60 })).body;
  const view = (await call('GET', `/api/public/booking/${s.token}`, null, { auth: false })).body;
  assert.equal(view.can_request_change, true);
  assert.equal(view.late_window, true);
  assert.match(view.policy, /24 hours' notice/);

  const noAck = await call('POST', `/api/public/booking/${s.token}/change`, { kind: 'cancel' }, { auth: false });
  assert.equal(noAck.status, 409, 'must acknowledge first');
  assert.match(noAck.body.error, /confirm you understand/);

  const ok = await call('POST', `/api/public/booking/${s.token}/change`, { kind: 'cancel', acknowledge_policy: true }, { auth: false });
  assert.equal(ok.status, 201);
  const c = (await call('GET', '/api/admin/dashboard')).body.changes.find((x: Json) => x.session_id === s.id);
  assert.equal(c.late, 1);
  assert.equal(c.policy_ack, 1);
  await call('POST', `/api/admin/changes/${c.id}/approve`, {});
  const row = (await call('GET', '/api/admin/cancellations')).body.rows.find((x: Json) => x.id === s.id);
  assert.equal(row.late_cancel, 1, 'approved late request is recorded as a late cancel');

  // Outside the window, no acknowledgement is needed.
  const fam = (await call('GET', `/api/public/family/${alex.portal_token}`, null, { auth: false })).body;
  const far = fam.upcoming.find((x: Json) => x.can_request_change && !x.late_window);
  assert.ok(far && far.policy === null);
});

test('security: headers, CSRF guard, audit log, log out everywhere', async () => {
  const res = await fetch(`${h.base}/api/public/info`);
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');

  // A cross-site HTML form can only send urlencoded/multipart/text bodies: rejected.
  const forged = await fetch(`${h.base}/api/admin/logout-everywhere`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: h.cookie }, body: 'x=1',
  });
  assert.equal(forged.status, 415);
  const plain = await fetch(`${h.base}/api/public/requests`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(plain.status, 415);

  await call('POST', '/api/auth/login', { password: 'wrong' }, { auth: false });
  const audit = (await call('GET', '/api/admin/audit')).body;
  assert.ok(audit.failed_logins_24h >= 2, 'failed logins counted');
  assert.ok(audit.events.some((e: Json) => e.action === 'login.ok'));
  assert.ok(audit.events.some((e: Json) => e.action.startsWith('POST /api/admin/')));

  const r = await call('POST', '/api/admin/logout-everywhere');
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/admin/dashboard')).status, 401, 'old cookie is dead');
  const again = await call('POST', '/api/auth/login', { password: 'pw' }, { auth: false });
  h.cookie = again.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await call('GET', '/api/admin/dashboard')).status, 200, 'new login works');
});

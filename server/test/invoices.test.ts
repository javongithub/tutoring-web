import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { one, openDb } from '../db.ts';
import { Harness, type Json } from './harness.ts';
import { createNotifier } from '../lib/notify.ts';
import { autoInvoice, prevPeriod } from '../lib/invoices.ts';
import { addDays, today } from '../lib/time.ts';

const db = openDb(':memory:');
const notify = createNotifier(db, { smtp: { from: 'me@x.com' }, origin: () => 'https://t.example' });
const h = new Harness(db, { notify });
const { call } = h;
const period = prevPeriod();
const d = (n: Json) => `${period}-${String(n).padStart(2, '0')}`;

before(async () => {
  db.prepare("UPDATE settings SET value = 'julian-tutor' WHERE key = 'venmo_handle'").run();
  db.prepare("UPDATE settings SET value = '949-555-0100' WHERE key = 'zelle_contact'").run();
  await h.start();
  await h.login();
});
after(() => h.close());

let amy: Json; let ben: Json;
const logged = async (studentId: number, day: number, extra: { cancelCharged?: boolean } = {}) => {
  const s = (await call('POST', '/api/admin/sessions', { student_id: studentId, start_at: `${d(day)}T16:00`, duration_min: 60 })).body;
  if (extra.cancelCharged) await call('POST', `/api/admin/sessions/${s.id}/cancel`, { by: 'client', charged: 1 });
  else await call('POST', `/api/admin/sessions/${s.id}/complete`, { topics: 'x' });
  return s.id;
};

test('preview lists billable, unpaid sessions per family for the month', async () => {
  amy = (await call('POST', '/api/admin/students', { name: 'Amy', parent_name: 'Ms. A', email: 'a@example.com' })).body;
  ben = (await call('POST', '/api/admin/students', { name: 'Ben' })).body; // no email
  await logged(amy.id, 3); await logged(amy.id, 10); await logged(amy.id, 17, { cancelCharged: true });
  await logged(ben.id, 5);
  // Not billable: a scheduled future session and a free cancellation.
  const s = (await call('POST', '/api/admin/sessions', { student_id: amy.id, start_at: `${d(20)}T16:00`, duration_min: 60 })).body;
  await call('POST', `/api/admin/sessions/${s.id}/cancel`, { by: 'client', charged: 0 });
  const { body } = await call('GET', `/api/admin/invoices?period=${period}`);
  const a = body.preview.find((p: Json) => p.name === 'Amy');
  assert.equal(a.sessions, 3);
  assert.equal(a.amount_cents, 9000);
});

let invA: Json;
test('create & send: itemized email with pay instructions; families without email flagged', async () => {
  db.prepare('DELETE FROM outbox').run();
  const r = await call('POST', '/api/admin/invoices', { period, send: true });
  assert.deepEqual(r.body, { created: 2, emailed: 1, no_email: 1 });
  const mail = one<Json>(db, "SELECT * FROM outbox WHERE to_addr = 'a@example.com'");
  assert.match(mail.subject, /Tutoring invoice for Amy, .* \$90/);
  assert.match(mail.body, /late cancellation/);
  assert.match(mail.body, /Venmo: @julian-tutor/);
  assert.match(mail.body, /Zelle: 949-555-0100/);
  assert.match(mail.body, /https:\/\/t\.example\/invoice\//);
  const list = (await call('GET', `/api/admin/invoices?period=${period}`)).body;
  assert.equal(list.preview.length, 0, 'nothing left to bill');
  invA = list.invoices.find((i: Json) => i.student_name === 'Amy');
  assert.equal(invA.sessions, 3);
  assert.equal((await call('POST', '/api/admin/invoices', { period })).body.created, 0, 'no duplicates');
  const benInv = list.invoices.find((i: Json) => i.student_name === 'Ben');
  assert.equal((await call('POST', `/api/admin/invoices/${benInv.id}/send`)).status, 400);
});

test('public invoice page by token; family page lists invoices', async () => {
  const pub = await call('GET', `/api/public/invoice/${invA.token}`, null, false);
  assert.equal(pub.body.amount_cents, 9000);
  assert.equal(pub.body.items.length, 3);
  assert.equal(pub.body.pay.venmo, 'julian-tutor');
  assert.ok(!('email' in pub.body), 'no contact details leaked');
  assert.equal((await call('GET', '/api/public/invoice/nope', null, false)).status, 404);
  const fam = (await call('GET', `/api/public/family/${amy.portal_token}`, null, false)).body;
  assert.equal(fam.invoices[0].amount_cents, 9000);
});

test('late-logged session tops up the open invoice; paid marks sessions paid', async () => {
  await logged(amy.id, 25);
  await call('POST', '/api/admin/invoices', { period });
  let inv = (await call('GET', `/api/admin/invoices/${invA.id}`)).body;
  assert.equal(inv.amount_cents, 12000);
  inv = (await call('POST', `/api/admin/invoices/${invA.id}/paid`)).body;
  assert.equal(inv.status, 'paid');
  assert.ok(inv.items.every((s: Json) => s.paid === 1));
  assert.equal((await call('GET', '/api/admin/dashboard')).body.earnings.unpaid.cents, 3000, 'only Ben unpaid');
});

test('marking every session paid individually closes the invoice; void releases sessions', async () => {
  const benInv = (await call('GET', `/api/admin/invoices?period=${period}`)).body.invoices.find((i: Json) => i.student_name === 'Ben');
  await call('POST', `/api/admin/invoices/${benInv.id}/void`);
  assert.equal((await call('GET', `/api/admin/invoices?period=${period}`)).body.preview.length, 1, 'Ben billable again');
  await call('POST', '/api/admin/invoices', { period });
  const again = (await call('GET', `/api/admin/invoices?period=${period}`)).body.invoices.find((i: Json) => i.student_name === 'Ben' && i.status === 'open');
  await call('POST', '/api/admin/sessions/mark-paid', { student_id: ben.id });
  assert.equal((await call('GET', `/api/admin/invoices/${again.id}`)).body.status, 'paid');
});

test('auto-invoice runs once per month when enabled', () => {
  assert.equal(autoInvoice(db, notify), null, 'off by default');
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'auto_invoice'").run();
  assert.ok(Array.isArray(autoInvoice(db, notify)));
  assert.equal(autoInvoice(db, notify), null, 'not twice in the same month');
  assert.ok(addDays(today(), 0));
});

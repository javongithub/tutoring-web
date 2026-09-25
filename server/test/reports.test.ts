import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { all, one, openDb } from '../db.ts';
import { Harness, type Json } from './harness.ts';
import { createNotifier } from '../lib/notify.ts';
import { type ReportClient, buildPrompt, createReporter, REPORT_MODEL } from '../lib/reports.ts';
import { addDays, today } from '../lib/time.ts';

const requests: Json[] = [];
let nextResponse: Json = null;
// Stand-in for the Anthropic client: records the request, returns a canned response.
const fakeClient = {
  beta: {
    messages: {
      create: async (params: Json) => {
        requests.push(params);
        if (nextResponse instanceof Error) throw nextResponse;
        return nextResponse ?? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'We worked on quadratics. Great progress.' }], usage: {} };
      },
    },
  },
};

const db = openDb(':memory:');
const h = new Harness(db, {
  notify: createNotifier(db, { smtp: { from: 'me@x.com' }, origin: () => 'https://t.example' }),
  reporter: createReporter({ client: fakeClient as unknown as ReportClient }), aiEnabled: true,
});
const { call } = h;

before(async () => {
  await h.start();
  await h.login();
});
after(() => h.close());

let st: Json;
test('prompt contains notes but no parent contact details or last name', async () => {
  st = (await call('POST', '/api/admin/students', {
    name: 'Amy Zhang', parent_name: 'Ms. Zhang', email: 'zhang@example.com', phone: '555-0100', grade: '8', subject: 'Algebra',
  })).body;
  const s = (await call('POST', '/api/admin/sessions', { student_id: st.id, start_at: `${addDays(today(), -5)}T16:00`, duration_min: 60 })).body;
  await call('POST', `/api/admin/sessions/${s.id}/complete`, { topics: 'Factoring', notes: 'Struggled with signs', next_plan: 'Quadratic formula' });
  const student = one<Json>(db, 'SELECT * FROM students WHERE id = ?', st.id);
  const sessions = all<Json>(db, 'SELECT * FROM sessions WHERE student_id = ?', st.id);
  const prompt = buildPrompt(student, sessions, addDays(today(), -30), today());
  assert.match(prompt, /Student: Amy, grade 8, Algebra/);
  assert.match(prompt, /Covered: Factoring \| Notes: Struggled with signs \| Next time: Quadratic formula/);
  for (const secret of ['Zhang', 'zhang@example.com', '555-0100']) assert.ok(!prompt.includes(secret), `${secret} leaked`);
});

let rep: Json;
test('AI draft: correct model + fallback opt-in, saved as an editable draft', async () => {
  const r = await call('POST', `/api/admin/students/${st.id}/reports`, { ai: true });
  assert.equal(r.status, 201);
  rep = r.body;
  assert.equal(rep.status, 'draft');
  assert.equal(rep.source, 'ai');
  assert.match(rep.body, /quadratics/);
  const req = requests.at(-1);
  assert.equal(req.model, REPORT_MODEL);
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.ok(req.max_tokens >= 1024);
  const edited = await call('PATCH', `/api/admin/reports/${rep.id}`, { body: 'Edited by tutor.' });
  assert.equal(edited.body.body, 'Edited by tutor.');
});

test('send publishes to family page + emails the parent', async () => {
  assert.equal((await call('GET', `/api/public/report/${rep.token}`, null, false)).status, 404, 'drafts are private');
  const sent = await call('POST', `/api/admin/reports/${rep.id}/send`);
  assert.equal(sent.body.status, 'sent');
  const mail = one<Json>(db, "SELECT * FROM outbox WHERE to_addr = 'zhang@example.com'");
  assert.match(mail.subject, /Amy Zhang's progress report/);
  assert.match(mail.body, /Edited by tutor\./);
  const pub = (await call('GET', `/api/public/report/${rep.token}`, null, false)).body;
  assert.equal(pub.body, 'Edited by tutor.');
  const fam = (await call('GET', `/api/public/family/${st.portal_token}`, null, false)).body;
  assert.equal(fam.reports.length, 1);
  assert.equal((await call('DELETE', `/api/admin/reports/${rep.id}`)).status, 400);
});

test('refusal, API errors and empty notes produce clear messages', async () => {
  nextResponse = { stop_reason: 'refusal', content: [], usage: {} };
  let r = await call('POST', `/api/admin/students/${st.id}/reports`, { ai: true });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /declined/);

  nextResponse = new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers());
  r = await call('POST', `/api/admin/students/${st.id}/reports`, { ai: true });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /busy/);
  nextResponse = null;

  const empty = (await call('POST', '/api/admin/students', { name: 'New' })).body;
  r = await call('POST', `/api/admin/students/${empty.id}/reports`, { ai: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /No session notes/);
  const manual = await call('POST', `/api/admin/students/${empty.id}/reports`, {});
  assert.equal(manual.status, 201);
  assert.equal(manual.body.source, 'manual');
  const again = await call('POST', `/api/admin/students/${empty.id}/reports`, {});
  assert.equal(again.body.id, manual.body.id, 'blank draft reused, not duplicated');
});

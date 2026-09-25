import { Router } from 'express';
import { getSettings, newToken } from '../db.js';
import { addDays, addMinutes, isDate, isDateTime, minutesBetween, nowLocal, today, weekStart } from '../lib/time.js';
import { cancelSession, isLateCancel, materializeRecurring, occupied, openSlots } from '../lib/schedule.js';
import { bad, isEmail, notFound, rateLimit, str } from '../lib/http.js';
import { buildFeed } from '../lib/gcal.js';

// Everything here is reachable without logging in, so responses only ever include
// the viewing family's own data. Other families show as "Other student", and the
// tutor's classes/clubs/etc. show as "Busy".
export default function publicRoutes(db) {
  const r = Router();
  const one = (sql, ...a) => db.prepare(sql).get(...a);

  const familyByToken = (token) => {
    const st = token ? one('SELECT id, name, parent_name, portal_token FROM students WHERE portal_token = ? AND active = 1', String(token)) : null;
    if (token && !st) throw notFound('This family link is no longer valid. Ask for a new one.');
    return st;
  };

  const openChange = (sessionId) => one(
    "SELECT kind, new_start_at, new_end_at, reason, requested_at FROM change_requests WHERE session_id = ? AND status = 'pending'", sessionId,
  ) || null;
  const lastDecision = (sessionId) => one(
    `SELECT kind, new_start_at, status, tutor_note, decided_at FROM change_requests
      WHERE session_id = ? AND status IN ('approved','declined') ORDER BY decided_at DESC LIMIT 1`, sessionId,
  ) || null;

  const publicSession = (s) => ({
    token: s.token, start_at: s.start_at, end_at: s.end_at, status: s.status,
    student: s.student_name || s.requester_student, cancelled_by: s.cancelled_by, late_cancel: s.late_cancel,
    change_request: openChange(s.id), last_decision: lastDecision(s.id),
    can_request_change: s.status === 'confirmed' && s.start_at > nowLocal() && !openChange(s.id),
    can_withdraw: s.status === 'pending' && s.start_at > nowLocal(),
  });

  r.get('/info', (_req, res) => {
    const s = getSettings(db);
    res.json({
      tutor_name: s.tutor_name, slot_minutes: s.slot_minutes, booking_weeks_ahead: s.booking_weeks_ahead,
      cancel_notice_hours: s.cancel_notice_hours, min_notice_hours: s.min_notice_hours, today: today(),
      rate_cents: s.default_rate_cents,
    });
  });

  // One week of the tutor's schedule: open slots plus labelled busy blocks.
  r.get('/week', (req, res) => {
    const start = isDate(req.query.start) ? weekStart(req.query.start) : weekStart(today());
    const end = addDays(start, 7);
    const family = familyByToken(req.query.family);
    materializeRecurring(db);
    const busy = occupied(db, start, end, family?.id ?? null);
    res.json({
      start,
      today: today(),
      max_date: addDays(today(), getSettings(db).booking_weeks_ahead * 7),
      occupied: busy.map(({ start_at, end_at, kind, label, status }) => ({ start_at, end_at, kind, label, ...(kind === 'own' ? { status } : {}) })),
      slots: openSlots(db, start, end, busy),
    });
  });

  r.post('/requests', rateLimit({ max: 8, windowMs: 60 * 60 * 1000 }), (req, res) => {
    const b = req.body || {};
    if (str(b.website)) return res.status(201).json({ token: newToken() }); // honeypot: silently drop bots
    const family = familyByToken(b.family);
    const start = str(b.start_at);
    if (!isDateTime(start)) throw bad('Pick a time slot');
    const parent = str(b.parent_name, 120) || family?.parent_name || '';
    const student = str(b.student_name, 120) || family?.name || '';
    const email = str(b.email, 200);
    const phone = str(b.phone, 40);
    if (!family) {
      if (!parent || !student) throw bad('Please enter your name and the student’s name');
      if (!isEmail(email)) throw bad('Please enter a valid email');
    }
    const { slot_minutes: len } = getSettings(db);
    const day = start.slice(0, 10);
    materializeRecurring(db);
    const open = openSlots(db, day, addDays(day, 1));
    if (!open.some((s) => s.start_at === start)) throw bad('Sorry, that time was just taken. Please pick another slot.');
    const token = newToken();
    const rate = family ? one('SELECT rate_cents FROM students WHERE id = ?', family.id).rate_cents : getSettings(db).default_rate_cents;
    db.prepare(
      `INSERT INTO sessions (student_id, start_at, end_at, status, source, rate_cents, token,
         requester_name, requester_student, requester_email, requester_phone, requester_message)
       VALUES (?, ?, ?, 'pending', 'booking', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(family?.id ?? null, start, addMinutes(start, len), rate, token, parent, student, email, phone, str(b.message, 2000));
    res.status(201).json({ token });
  });

  const byToken = (token) => {
    const s = one('SELECT s.*, st.name AS student_name, st.portal_token FROM sessions s LEFT JOIN students st ON st.id = s.student_id WHERE s.token = ?', String(token));
    if (!s) throw notFound('Booking not found');
    return s;
  };

  r.get('/booking/:token', (req, res) => {
    const s = byToken(req.params.token);
    res.json({
      ...publicSession(s),
      // Once confirmed, hand the family their portal link so they can see and manage future sessions.
      family_token: ['confirmed', 'completed'].includes(s.status) ? s.portal_token : null,
    });
  });

  const limiter = rateLimit({ max: 20, windowMs: 60 * 60 * 1000 });

  // Withdraw a booking request the tutor hasn't confirmed yet (nothing was scheduled, so no approval needed).
  r.post('/booking/:token/withdraw', limiter, (req, res) => {
    const s = byToken(req.params.token);
    if (s.status !== 'pending') throw bad('Only unconfirmed requests can be withdrawn. Ask to cancel instead.');
    cancelSession(db, s, { by: 'client', reason: str(req.body?.reason, 1000) || 'Request withdrawn', late: 0 });
    res.json(publicSession(byToken(s.token)));
  });

  // Ask to cancel or move a confirmed session. The session stays as-is until the tutor approves.
  r.post('/booking/:token/change', limiter, (req, res) => {
    const s = byToken(req.params.token);
    if (s.status !== 'confirmed' || s.start_at <= nowLocal()) throw bad('This session can no longer be changed online');
    if (openChange(s.id)) throw bad('You already have a request waiting on this session');
    const kind = req.body?.kind === 'reschedule' ? 'reschedule' : 'cancel';
    const reason = str(req.body?.reason, 1000);
    let newStart = null; let newEnd = null;
    if (kind === 'reschedule') {
      newStart = str(req.body.new_start_at);
      if (!isDateTime(newStart)) throw bad('Pick a new time');
      newEnd = addMinutes(newStart, minutesBetween(s.start_at, s.end_at));
      const day = newStart.slice(0, 10);
      const busy = occupied(db, day, addDays(day, 1), null, { excludeSessionId: s.id });
      const lenOk = openSlots(db, day, addDays(day, 1), busy).some((x) => x.start_at === newStart);
      const clash = busy.some((b) => b.start_at < newEnd && newStart < b.end_at);
      if (!lenOk || clash) throw bad('That time isn’t open. Please pick one of the open slots.');
    }
    db.prepare(
      `INSERT INTO change_requests (session_id, kind, new_start_at, new_end_at, reason, late, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.id, kind, newStart, newEnd, reason, kind === 'cancel' ? isLateCancel(db, s.start_at) : 0, nowLocal());
    res.status(201).json(publicSession(byToken(s.token)));
  });

  r.post('/booking/:token/change/withdraw', limiter, (req, res) => {
    const s = byToken(req.params.token);
    const info = db.prepare("UPDATE change_requests SET status='withdrawn', decided_at=? WHERE session_id=? AND status='pending'")
      .run(nowLocal(), s.id);
    if (!info.changes) throw bad('No open request to withdraw');
    res.json(publicSession(byToken(s.token)));
  });

  // Private iCal feed of your sessions (URL contains a secret; rotate it in Settings).
  r.get('/feed/:token', (req, res) => {
    const { feed_token: t } = getSettings(db);
    if (!t || req.params.token.replace(/\.ics$/, '') !== t) throw notFound();
    materializeRecurring(db);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.send(buildFeed(db));
  });

  r.get('/family/:token', (req, res) => {
    const fam = familyByToken(req.params.token);
    materializeRecurring(db);
    const rows = db.prepare(
      `SELECT s.*, ? AS student_name FROM sessions s
        WHERE s.student_id = ? AND s.start_at >= ? AND s.start_at < ? AND s.status <> 'declined'
        ORDER BY s.start_at`,
    ).all(fam.name, fam.id, `${addDays(today(), -28)}T00:00`, `${addDays(today(), 56)}T00:00`);
    const now = nowLocal();
    res.json({
      student: fam.name,
      parent: fam.parent_name,
      cancel_notice_hours: getSettings(db).cancel_notice_hours,
      upcoming: rows.filter((s) => s.end_at > now && s.status !== 'cancelled').map(publicSession),
      cancelled: rows.filter((s) => s.end_at > now && s.status === 'cancelled').map(publicSession),
      recent: rows.filter((s) => s.end_at <= now).reverse().slice(0, 8).map(publicSession),
    });
  });

  return r;
}

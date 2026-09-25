import { Router } from 'express';
import { getSettings, newToken, DEFAULT_SETTINGS, tx } from '../db.js';
import {
  addDays, addMinutes, isDate, isDateTime, isTime, minutesBetween, nowLocal, today, weekStart, toMs,
} from '../lib/time.js';
import {
  cancelSession, clearFutureInstances, materializeRecurring, moveSession, occupied, syncCalendar, validRange,
} from '../lib/schedule.js';
import { parseTutoringTitle } from '../lib/ics.js';
import { bad, bool, int, notFound, str } from '../lib/http.js';

const SESSION_SELECT = `
  SELECT s.*, st.name AS student_name, st.parent_name, st.next_plan AS student_next_plan
    FROM sessions s LEFT JOIN students st ON st.id = s.student_id`;

const CHANGE_SELECT = `
  SELECT c.*, s.start_at, s.end_at, s.status AS session_status, s.recurring_id, st.name AS student_name, st.parent_name
    FROM change_requests c JOIN sessions s ON s.id = c.session_id LEFT JOIN students st ON st.id = s.student_id`;

// A session earns money if it happened, or if it was a billed late cancel / no-show.
const BILLABLE = "(s.status = 'completed' OR s.charged = 1)";

export default function adminRoutes(db, { gcalEmail = null, onChange = () => {} } = {}) {
  const r = Router();
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const getSession = (id) => {
    const s = one(`${SESSION_SELECT} WHERE s.id = ?`, id);
    if (!s) throw notFound('Session not found');
    return s;
  };
  const getStudent = (id) => {
    const s = one('SELECT * FROM students WHERE id = ?', id);
    if (!s) throw notFound('Student not found');
    return s;
  };

  r.use((_req, _res, next) => { materializeRecurring(db); next(); });

  // ---------- Dashboard ----------
  r.get('/dashboard', (_req, res) => {
    const now = nowLocal();
    const t = today();
    const wk = weekStart(t);
    const month = `${t.slice(0, 7)}-01`;
    const sum = (from, to) => one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(rate_cents), 0) AS cents FROM sessions s
        WHERE ${BILLABLE} AND start_at >= ? AND start_at < ?`, `${from}T00:00`, `${to}T00:00`,
    );
    const nextMonth = addDays(month, 32).slice(0, 7) + '-01';
    res.json({
      now,
      earnings: {
        week: sum(wk, addDays(wk, 7)),
        month: sum(month, nextMonth),
        all_time: sum('0000-01-01', '9999-01-01'),
        unpaid: one(`SELECT COUNT(*) AS n, COALESCE(SUM(rate_cents), 0) AS cents FROM sessions s WHERE ${BILLABLE} AND paid = 0`),
        scheduled_week: one(
          `SELECT COUNT(*) AS n, COALESCE(SUM(rate_cents), 0) AS cents FROM sessions s
            WHERE status IN ('confirmed','completed') AND start_at >= ? AND start_at < ?`,
          `${wk}T00:00`, `${addDays(wk, 7)}T00:00`,
        ),
      },
      pending: all(`${SESSION_SELECT} WHERE s.status = 'pending' ORDER BY s.start_at`),
      changes: all(`${CHANGE_SELECT} WHERE c.status = 'pending' ORDER BY c.requested_at`),
      needs_log: all(`${SESSION_SELECT} WHERE s.status = 'confirmed' AND s.end_at <= ? ORDER BY s.start_at DESC LIMIT 50`, now),
      upcoming: all(`${SESSION_SELECT} WHERE s.status = 'confirmed' AND s.end_at > ? ORDER BY s.start_at LIMIT 12`, now),
      recent_cancels: all(`${SESSION_SELECT} WHERE s.status = 'cancelled' ORDER BY s.cancelled_at DESC LIMIT 5`),
    });
  });

  // ---------- Sessions ----------
  r.get('/sessions', (req, res) => {
    const { from, to } = req.query;
    if (!validRange(from, to)) throw bad('from/to must be dates, at most 62 days apart');
    const where = ['s.start_at < ?', 's.end_at > ?'];
    const args = [`${to}T00:00`, `${from}T00:00`];
    if (req.query.student_id) { where.push('s.student_id = ?'); args.push(int(req.query.student_id)); }
    const sessions = all(`${SESSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.start_at`, ...args);
    const calendar = all('SELECT * FROM calendar_events WHERE start_at < ? AND end_at > ? ORDER BY start_at', ...args.slice(0, 2));
    const blocks = all('SELECT * FROM blocks');
    res.json({ sessions, calendar, blocks });
  });

  r.post('/sessions', (req, res) => {
    const studentId = int(req.body.student_id);
    const student = getStudent(studentId);
    const start = str(req.body.start_at);
    const duration = int(req.body.duration_min, 60);
    if (!isDateTime(start)) throw bad('start_at must be YYYY-MM-DDTHH:MM');
    if (duration < 15 || duration > 480) throw bad('duration must be 15–480 minutes');
    if (bool(req.body.repeat_weekly)) {
      const info = db.prepare(
        'INSERT INTO recurring (student_id, weekday, start_time, duration_min, starts_on, ends_on) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(studentId, new Date(toMs(start)).getUTCDay(), start.slice(11), duration, start.slice(0, 10),
        isDate(req.body.ends_on) ? req.body.ends_on : null);
      materializeRecurring(db, Number(info.lastInsertRowid));
      return res.status(201).json({ recurring_id: Number(info.lastInsertRowid) });
    }
    const info = db.prepare(
      'INSERT INTO sessions (student_id, start_at, end_at, status, rate_cents, token) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(studentId, start, addMinutes(start, duration), 'confirmed', student.rate_cents, newToken());
    res.status(201).json(getSession(info.lastInsertRowid));
  });

  r.patch('/sessions/:id', (req, res) => {
    const s = getSession(int(req.params.id));
    const b = req.body;
    const next = {
      start_at: b.start_at !== undefined ? str(b.start_at) : s.start_at,
      end_at: s.end_at,
      topics: b.topics !== undefined ? str(b.topics, 5000) : s.topics,
      notes: b.notes !== undefined ? str(b.notes, 5000) : s.notes,
      next_plan: b.next_plan !== undefined ? str(b.next_plan, 5000) : s.next_plan,
      paid: b.paid !== undefined ? bool(b.paid) : s.paid,
      charged: b.charged !== undefined ? bool(b.charged) : s.charged,
      rate_cents: b.rate_cents !== undefined ? int(b.rate_cents, s.rate_cents) : s.rate_cents,
      cancel_reason: b.cancel_reason !== undefined ? str(b.cancel_reason, 1000) : s.cancel_reason,
    };
    if (!isDateTime(next.start_at)) throw bad('start_at must be YYYY-MM-DDTHH:MM');
    const dur = b.duration_min !== undefined ? int(b.duration_min) : minutesBetween(s.start_at, s.end_at);
    if (!(dur >= 15 && dur <= 480)) throw bad('duration must be 15–480 minutes');
    next.end_at = addMinutes(next.start_at, dur);
    if (next.rate_cents < 0 || next.rate_cents > 100000) throw bad('rate out of range');
    db.prepare(
      `UPDATE sessions SET start_at=?, end_at=?, topics=?, notes=?, next_plan=?, paid=?, charged=?, rate_cents=?, cancel_reason=?
        WHERE id = ?`,
    ).run(next.start_at, next.end_at, next.topics, next.notes, next.next_plan, next.paid, next.charged,
      next.rate_cents, next.cancel_reason, s.id);
    if (b.next_plan !== undefined && s.student_id) syncStudentPlan(s.student_id);
    res.json(getSession(s.id));
  });

  // Student's "next time" plan always mirrors the most recent logged session that has one.
  function syncStudentPlan(studentId) {
    const latest = one(
      `SELECT next_plan FROM sessions WHERE student_id = ? AND status = 'completed' AND next_plan <> ''
        ORDER BY start_at DESC LIMIT 1`, studentId,
    );
    if (latest) db.prepare('UPDATE students SET next_plan = ? WHERE id = ?').run(latest.next_plan, studentId);
  }

  r.post('/sessions/:id/complete', (req, res) => {
    const s = getSession(int(req.params.id));
    if (!['confirmed', 'completed', 'no_show'].includes(s.status)) throw bad(`Cannot log a ${s.status} session`);
    db.prepare(
      "UPDATE sessions SET status='completed', charged=0, topics=?, notes=?, next_plan=? WHERE id=?",
    ).run(str(req.body.topics, 5000), str(req.body.notes, 5000), str(req.body.next_plan, 5000), s.id);
    if (s.student_id) syncStudentPlan(s.student_id);
    res.json(getSession(s.id));
  });

  r.post('/sessions/complete-past', (_req, res) => {
    const info = db.prepare("UPDATE sessions SET status='completed' WHERE status='confirmed' AND end_at <= ?").run(nowLocal());
    res.json({ updated: info.changes });
  });

  r.post('/sessions/:id/no-show', (req, res) => {
    const s = getSession(int(req.params.id));
    if (s.status !== 'confirmed') throw bad('Only confirmed sessions can be marked no-show');
    db.prepare("UPDATE sessions SET status='no_show', charged=? WHERE id=?").run(bool(req.body.charged ?? 1), s.id);
    res.json(getSession(s.id));
  });

  r.post('/sessions/:id/cancel', (req, res) => {
    const s = getSession(int(req.params.id));
    if (!['confirmed', 'pending'].includes(s.status)) throw bad(`Cannot cancel a ${s.status} session`);
    cancelSession(db, s, {
      by: req.body.by === 'tutor' ? 'tutor' : 'client',
      reason: str(req.body.reason, 1000),
      charged: req.body.charged !== undefined ? bool(req.body.charged) : undefined,
    });
    res.json(getSession(s.id));
  });

  r.post('/sessions/:id/reopen', (req, res) => {
    const s = getSession(int(req.params.id));
    if (!['cancelled', 'no_show', 'completed', 'declined'].includes(s.status)) throw bad('Nothing to undo');
    db.prepare(
      "UPDATE sessions SET status='confirmed', cancelled_by=NULL, cancel_reason='', cancelled_at=NULL, late_cancel=0, charged=0 WHERE id=?",
    ).run(s.id);
    res.json(getSession(s.id));
  });

  // Approve a website booking request. Links it to an existing student or creates one.
  r.post('/sessions/:id/confirm', (req, res) => {
    const s = getSession(int(req.params.id));
    if (s.status !== 'pending') throw bad('Only pending requests can be confirmed');
    const result = tx(db, () => {
      let studentId = s.student_id || int(req.body.student_id);
      if (studentId) getStudent(studentId);
      else {
        const st = getSettings(db);
        studentId = Number(db.prepare(
          'INSERT INTO students (name, parent_name, email, phone, rate_cents, notes, portal_token) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(s.requester_student || s.requester_name, s.requester_name, s.requester_email, s.requester_phone,
          st.default_rate_cents, s.requester_message ? `From booking request: ${s.requester_message}` : '', newToken()).lastInsertRowid);
      }
      const rate = one('SELECT rate_cents FROM students WHERE id = ?', studentId).rate_cents;
      db.prepare("UPDATE sessions SET status='confirmed', student_id=?, rate_cents=? WHERE id=?").run(studentId, rate, s.id);
      if (bool(req.body.repeat_weekly)) {
        const info = db.prepare(
          'INSERT INTO recurring (student_id, weekday, start_time, duration_min, starts_on) VALUES (?, ?, ?, ?, ?)',
        ).run(studentId, new Date(toMs(s.start_at)).getUTCDay(), s.start_at.slice(11),
          minutesBetween(s.start_at, s.end_at), addDays(s.start_at.slice(0, 10), 1));
        materializeRecurring(db, Number(info.lastInsertRowid));
      }
      return getSession(s.id);
    });
    res.json(result);
  });

  r.post('/sessions/:id/decline', (req, res) => {
    const s = getSession(int(req.params.id));
    if (s.status !== 'pending') throw bad('Only pending requests can be declined');
    db.prepare("UPDATE sessions SET status='declined', cancel_reason=?, cancelled_at=? WHERE id=?")
      .run(str(req.body.reason, 1000), nowLocal(), s.id);
    res.json(getSession(s.id));
  });

  r.delete('/sessions/:id', (req, res) => {
    const s = getSession(int(req.params.id));
    if (s.recurring_id) throw bad('This is part of a weekly schedule — cancel it instead, or edit the schedule');
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    res.json({ ok: true });
  });

  r.post('/sessions/mark-paid', (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => int(x)).filter(Boolean) : [];
    const paid = req.body.paid === undefined ? 1 : bool(req.body.paid);
    let changes = 0;
    if (ids.length) {
      const up = db.prepare('UPDATE sessions SET paid = ? WHERE id = ?');
      tx(db, () => { for (const id of ids) changes += up.run(paid, id).changes; });
    } else if (req.body.student_id) {
      changes = db.prepare(`UPDATE sessions AS s SET paid = 1 WHERE student_id = ? AND ${BILLABLE} AND paid = 0`)
        .run(int(req.body.student_id)).changes;
    } else throw bad('Provide ids or student_id');
    res.json({ updated: changes });
  });

  // ---------- Family change requests (cancel / move) ----------
  const getChange = (id) => {
    const c = one(`${CHANGE_SELECT} WHERE c.id = ?`, id);
    if (!c) throw notFound('Request not found');
    if (c.status !== 'pending') throw bad(`This request was already ${c.status}`);
    return c;
  };

  r.get('/changes', (req, res) => {
    const where = req.query.status === 'pending' ? "WHERE c.status = 'pending'" : '';
    res.json(all(`${CHANGE_SELECT} ${where} ORDER BY c.requested_at DESC LIMIT 300`));
  });

  r.post('/changes/:id/approve', (req, res) => {
    const c = getChange(int(req.params.id));
    const s = getSession(c.session_id);
    tx(db, () => {
      if (c.kind === 'cancel') {
        if (!['confirmed', 'pending'].includes(s.status)) throw bad(`Session is already ${s.status}`);
        cancelSession(db, s, {
          by: 'client', reason: c.reason, late: c.late,
          charged: req.body.charged !== undefined ? bool(req.body.charged) : undefined,
        });
      } else {
        if (s.status !== 'confirmed') throw bad(`Session is ${s.status}, can't move it`);
        const day = c.new_start_at.slice(0, 10);
        // excludeSessionId drops both the session itself and the slot this request is holding.
        const busy = occupied(db, day, addDays(day, 1), null, { excludeSessionId: s.id });
        const clash = busy.find((b) => b.start_at < c.new_end_at && c.new_start_at < b.end_at);
        if (clash && !bool(req.body.force)) {
          throw Object.assign(bad(`That time now overlaps something else (${clash.start_at.slice(11)}–${clash.end_at.slice(11)}). Decline, or approve anyway.`), { status: 409 });
        }
        moveSession(db, s, c.new_start_at, c.new_end_at);
      }
      db.prepare("UPDATE change_requests SET status='approved', decided_at=?, tutor_note=? WHERE id=?")
        .run(nowLocal(), str(req.body.note, 1000), c.id);
    });
    res.json(one(`${CHANGE_SELECT} WHERE c.id = ?`, c.id));
  });

  r.post('/changes/:id/decline', (req, res) => {
    const c = getChange(int(req.params.id));
    db.prepare("UPDATE change_requests SET status='declined', decided_at=?, tutor_note=? WHERE id=?")
      .run(nowLocal(), str(req.body.note, 1000), c.id);
    res.json(one(`${CHANGE_SELECT} WHERE c.id = ?`, c.id));
  });

  // ---------- Students ----------
  const studentFields = (b, prev = {}) => {
    const f = {
      name: b.name !== undefined ? str(b.name, 120) : prev.name,
      parent_name: b.parent_name !== undefined ? str(b.parent_name, 120) : prev.parent_name ?? '',
      email: b.email !== undefined ? str(b.email, 200) : prev.email ?? '',
      phone: b.phone !== undefined ? str(b.phone, 40) : prev.phone ?? '',
      grade: b.grade !== undefined ? str(b.grade, 60) : prev.grade ?? '',
      subject: b.subject !== undefined ? str(b.subject, 120) : prev.subject ?? '',
      rate_cents: b.rate_cents !== undefined ? int(b.rate_cents) : prev.rate_cents ?? getSettings(db).default_rate_cents,
      notes: b.notes !== undefined ? str(b.notes, 10000) : prev.notes ?? '',
      next_plan: b.next_plan !== undefined ? str(b.next_plan, 5000) : prev.next_plan ?? '',
      active: b.active !== undefined ? bool(b.active) : prev.active ?? 1,
    };
    if (!f.name) throw bad('Name is required');
    if (!(f.rate_cents >= 0 && f.rate_cents <= 100000)) throw bad('Rate out of range');
    return f;
  };

  r.get('/students', (_req, res) => {
    res.json(all(`
      SELECT st.*,
        (SELECT COUNT(*) FROM sessions s WHERE s.student_id = st.id AND s.status = 'completed') AS completed,
        (SELECT COUNT(*) FROM sessions s WHERE s.student_id = st.id AND s.status = 'cancelled' AND s.cancelled_by = 'client') AS client_cancels,
        (SELECT COALESCE(SUM(rate_cents),0) FROM sessions s WHERE s.student_id = st.id AND ${BILLABLE} AND s.paid = 0) AS unpaid_cents,
        (SELECT MIN(start_at) FROM sessions s WHERE s.student_id = st.id AND s.status = 'confirmed' AND s.start_at > ?) AS next_session
      FROM students st ORDER BY st.active DESC, st.name COLLATE NOCASE`, nowLocal()));
  });

  r.post('/students', (req, res) => {
    const f = studentFields(req.body);
    const info = db.prepare(
      `INSERT INTO students (name, parent_name, email, phone, grade, subject, rate_cents, notes, next_plan, active, portal_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(f.name, f.parent_name, f.email, f.phone, f.grade, f.subject, f.rate_cents, f.notes, f.next_plan, f.active, newToken());
    res.status(201).json(getStudent(info.lastInsertRowid));
  });

  r.get('/students/:id', (req, res) => {
    const st = getStudent(int(req.params.id));
    res.json({
      student: st,
      rules: all('SELECT * FROM recurring WHERE student_id = ? ORDER BY active DESC, weekday, start_time', st.id),
      // History = anything that already happened, plus cancellations/requests at any date.
      sessions: all(`${SESSION_SELECT} WHERE s.student_id = ? AND (s.start_at <= ? OR s.status <> 'confirmed') ORDER BY s.start_at DESC LIMIT 200`,
        st.id, nowLocal()),
      upcoming: all(`${SESSION_SELECT} WHERE s.student_id = ? AND s.status = 'confirmed' AND s.start_at > ? ORDER BY s.start_at LIMIT 8`,
        st.id, nowLocal()),
      stats: one(`
        SELECT
          SUM(status = 'completed') AS completed,
          SUM(status = 'cancelled' AND cancelled_by = 'client') AS client_cancels,
          SUM(status = 'cancelled' AND cancelled_by = 'client' AND late_cancel = 1) AS late_cancels,
          SUM(status = 'cancelled' AND cancelled_by = 'tutor') AS tutor_cancels,
          SUM(status = 'no_show') AS no_shows,
          COALESCE(SUM(CASE WHEN ${BILLABLE.replaceAll('s.', '')} THEN rate_cents END), 0) AS earned_cents,
          COALESCE(SUM(CASE WHEN ${BILLABLE.replaceAll('s.', '')} AND paid = 0 THEN rate_cents END), 0) AS unpaid_cents
        FROM sessions WHERE student_id = ?`, st.id),
    });
  });

  r.patch('/students/:id', (req, res) => {
    const prev = getStudent(int(req.params.id));
    const f = studentFields(req.body, prev);
    db.prepare(
      `UPDATE students SET name=?, parent_name=?, email=?, phone=?, grade=?, subject=?, rate_cents=?, notes=?, next_plan=?, active=?
        WHERE id=?`,
    ).run(f.name, f.parent_name, f.email, f.phone, f.grade, f.subject, f.rate_cents, f.notes, f.next_plan, f.active, prev.id);
    if (f.rate_cents !== prev.rate_cents) {
      // New rate applies to sessions that haven't happened yet.
      db.prepare("UPDATE sessions SET rate_cents = ? WHERE student_id = ? AND status IN ('confirmed','pending') AND start_at > ?")
        .run(f.rate_cents, prev.id, nowLocal());
    }
    if (!f.active && prev.active) {
      for (const rule of all('SELECT id FROM recurring WHERE student_id = ? AND active = 1', prev.id)) clearFutureInstances(db, rule.id);
    }
    res.json(getStudent(prev.id));
  });

  r.post('/students/:id/rotate-link', (req, res) => {
    const st = getStudent(int(req.params.id));
    db.prepare('UPDATE students SET portal_token = ? WHERE id = ?').run(newToken(), st.id);
    res.json(getStudent(st.id));
  });

  r.delete('/students/:id', (req, res) => {
    const st = getStudent(int(req.params.id));
    const logged = one("SELECT COUNT(*) AS n FROM sessions WHERE student_id = ? AND status IN ('completed','no_show')", st.id).n;
    if (logged) throw bad('Student has logged sessions — mark them inactive instead so your log and earnings stay intact');
    db.prepare('DELETE FROM students WHERE id = ?').run(st.id);
    res.json({ ok: true });
  });

  // ---------- Weekly schedules ----------
  const ruleFields = (b, prev = {}) => {
    const f = {
      weekday: b.weekday !== undefined ? int(b.weekday) : prev.weekday,
      start_time: b.start_time !== undefined ? str(b.start_time) : prev.start_time,
      duration_min: b.duration_min !== undefined ? int(b.duration_min) : prev.duration_min ?? 60,
      starts_on: b.starts_on !== undefined ? str(b.starts_on) : prev.starts_on ?? today(),
      ends_on: b.ends_on !== undefined ? (str(b.ends_on) || null) : prev.ends_on ?? null,
      active: b.active !== undefined ? bool(b.active) : prev.active ?? 1,
    };
    if (!(f.weekday >= 0 && f.weekday <= 6)) throw bad('weekday must be 0 (Sun) – 6 (Sat)');
    if (!isTime(f.start_time)) throw bad('start_time must be HH:MM');
    if (!(f.duration_min >= 15 && f.duration_min <= 480)) throw bad('duration must be 15–480 minutes');
    if (!isDate(f.starts_on)) throw bad('starts_on must be YYYY-MM-DD');
    if (f.ends_on && !isDate(f.ends_on)) throw bad('ends_on must be YYYY-MM-DD');
    return f;
  };

  r.post('/students/:id/rules', (req, res) => {
    const st = getStudent(int(req.params.id));
    const f = ruleFields(req.body);
    const info = db.prepare(
      'INSERT INTO recurring (student_id, weekday, start_time, duration_min, starts_on, ends_on, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(st.id, f.weekday, f.start_time, f.duration_min, f.starts_on, f.ends_on, f.active);
    materializeRecurring(db, Number(info.lastInsertRowid));
    res.status(201).json(one('SELECT * FROM recurring WHERE id = ?', info.lastInsertRowid));
  });

  r.patch('/rules/:id', (req, res) => {
    const prev = one('SELECT * FROM recurring WHERE id = ?', int(req.params.id));
    if (!prev) throw notFound('Schedule not found');
    const f = ruleFields(req.body, prev);
    tx(db, () => {
      clearFutureInstances(db, prev.id);
      db.prepare('UPDATE recurring SET weekday=?, start_time=?, duration_min=?, starts_on=?, ends_on=?, active=? WHERE id=?')
        .run(f.weekday, f.start_time, f.duration_min, f.starts_on, f.ends_on, f.active, prev.id);
    });
    materializeRecurring(db, prev.id);
    res.json(one('SELECT * FROM recurring WHERE id = ?', prev.id));
  });

  r.delete('/rules/:id', (req, res) => {
    const prev = one('SELECT * FROM recurring WHERE id = ?', int(req.params.id));
    if (!prev) throw notFound('Schedule not found');
    tx(db, () => {
      clearFutureInstances(db, prev.id);
      db.prepare('DELETE FROM recurring WHERE id = ?').run(prev.id);
    });
    res.json({ ok: true });
  });

  // ---------- Tutoring log ----------
  const logQuery = (q) => {
    const from = isDate(q.from) ? q.from : '0000-01-01';
    const to = isDate(q.to) ? q.to : '9000-01-01';
    const where = [`(s.status IN ('completed','no_show') OR s.charged = 1)`, 's.start_at >= ?', 's.start_at < ?'];
    const args = [`${from}T00:00`, `${addDays(to, 1)}T00:00`];
    if (q.student_id) { where.push('s.student_id = ?'); args.push(int(q.student_id)); }
    if (q.paid === '0' || q.paid === '1') { where.push('s.paid = ?'); args.push(Number(q.paid)); }
    return all(`${SESSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.start_at DESC`, ...args);
  };

  r.get('/log', (req, res) => {
    const rows = logQuery(req.query);
    const billable = rows.filter((x) => x.status === 'completed' || x.charged);
    res.json({
      rows,
      totals: {
        sessions: rows.filter((x) => x.status === 'completed').length,
        hours: rows.filter((x) => x.status === 'completed').reduce((h, x) => h + minutesBetween(x.start_at, x.end_at) / 60, 0),
        earned_cents: billable.reduce((c, x) => c + x.rate_cents, 0),
        unpaid_cents: billable.filter((x) => !x.paid).reduce((c, x) => c + x.rate_cents, 0),
      },
    });
  });

  r.get('/log.csv', (req, res) => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Date', 'Start', 'End', 'Student', 'Status', 'Amount', 'Paid', 'Covered', 'Notes', 'Next time'].join(',')];
    for (const x of logQuery(req.query)) {
      const billable = x.status === 'completed' || x.charged;
      lines.push([x.start_at.slice(0, 10), x.start_at.slice(11), x.end_at.slice(11), x.student_name, x.status,
        billable ? (x.rate_cents / 100).toFixed(2) : '0.00', x.paid ? 'yes' : 'no', x.topics, x.notes, x.next_plan].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tutoring-log-${today()}.csv"`);
    res.send(lines.join('\n'));
  });

  // ---------- Cancellations ----------
  r.get('/cancellations', (req, res) => {
    const from = isDate(req.query.from) ? req.query.from : addDays(today(), -90);
    const to = isDate(req.query.to) ? req.query.to : addDays(today(), 90);
    const args = [`${from}T00:00`, `${addDays(to, 1)}T00:00`];
    res.json({
      rows: all(`${SESSION_SELECT} WHERE s.status IN ('cancelled','declined','no_show') AND s.start_at >= ? AND s.start_at < ?
                 ORDER BY COALESCE(s.cancelled_at, s.start_at) DESC`, ...args),
      by_student: all(`
        SELECT st.id, st.name,
          SUM(s.status = 'cancelled' AND s.cancelled_by = 'client') AS client_cancels,
          SUM(s.status = 'cancelled' AND s.cancelled_by = 'client' AND s.late_cancel = 1) AS late_cancels,
          SUM(s.status = 'no_show') AS no_shows,
          SUM(s.status = 'cancelled' AND s.cancelled_by = 'tutor') AS tutor_cancels,
          SUM(s.status IN ('completed','cancelled','no_show')) AS total,
          COALESCE(SUM(CASE WHEN s.status = 'cancelled' AND s.charged = 0 THEN s.rate_cents END), 0) AS lost_cents
        FROM sessions s JOIN students st ON st.id = s.student_id
        WHERE s.start_at >= ? AND s.start_at < ?
        GROUP BY st.id HAVING client_cancels + no_shows + tutor_cancels > 0
        ORDER BY client_cancels + no_shows DESC`, ...args),
      from, to,
    });
  });

  // ---------- Settings, availability, blocked times ----------
  r.get('/settings', (_req, res) => {
    res.json({
      settings: getSettings(db),
      gcal_service_account: gcalEmail,
      availability: all('SELECT * FROM availability ORDER BY weekday, start_time'),
      blocks: all('SELECT * FROM blocks ORDER BY weekday, start_time'),
    });
  });

  r.put('/settings', (req, res) => {
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const editable = ['tutor_name', 'default_rate_cents', 'slot_minutes', 'min_notice_hours', 'booking_weeks_ahead',
      'cancel_notice_hours', 'charge_late_cancels', 'ics_url', 'gcal_calendar_id'];
    tx(db, () => {
      for (const k of editable) {
        if (req.body[k] === undefined) continue;
        let v = req.body[k];
        if (typeof DEFAULT_SETTINGS[k] === 'number') {
          v = int(v);
          if (v === null || v < 0 || v > 100000) throw bad(`${k} is invalid`);
        } else v = str(v, 1000);
        if (k === 'ics_url' && v && !/^https:\/\/\S+$/.test(v.replace(/^webcal:/, 'https:'))) throw bad('Calendar URL must start with https://');
        if (k === 'ics_url') v = v.replace(/^webcal:/, 'https:');
        if (k === 'slot_minutes' && (v < 15 || v > 240)) throw bad('Session length must be 15–240 minutes');
        up.run(k, String(v));
      }
    });
    res.json(getSettings(db));
  });

  const replaceWeekly = (table, rows, withLabel) => {
    if (!Array.isArray(rows)) throw bad('Expected a list');
    const clean = rows.map((x) => {
      const f = { weekday: int(x.weekday), start_time: str(x.start_time), end_time: str(x.end_time), label: str(x.label, 120) };
      if (!(f.weekday >= 0 && f.weekday <= 6) || !isTime(f.start_time) || !isTime(f.end_time) || f.start_time >= f.end_time) {
        throw bad('Each row needs a weekday and start time before end time');
      }
      return f;
    });
    tx(db, () => {
      db.prepare(`DELETE FROM ${table}`).run();
      const ins = withLabel
        ? db.prepare(`INSERT INTO ${table} (label, weekday, start_time, end_time) VALUES (?, ?, ?, ?)`)
        : db.prepare(`INSERT INTO ${table} (weekday, start_time, end_time) VALUES (?, ?, ?)`);
      for (const f of clean) (withLabel ? ins.run(f.label || 'Busy', f.weekday, f.start_time, f.end_time) : ins.run(f.weekday, f.start_time, f.end_time));
    });
  };
  r.put('/availability', (req, res) => { replaceWeekly('availability', req.body, false); res.json(all('SELECT * FROM availability ORDER BY weekday, start_time')); });
  r.put('/blocks', (req, res) => { replaceWeekly('blocks', req.body, true); res.json(all('SELECT * FROM blocks ORDER BY weekday, start_time')); });

  // ---------- Google Calendar ----------
  r.post('/calendar/rotate-feed', (_req, res) => {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'feed_token'").run(newToken());
    res.json(getSettings(db));
  });

  // Re-send every session in the window to Google Calendar (e.g. after first setup).
  r.post('/calendar/push-all', (_req, res) => {
    const n = db.prepare('UPDATE sessions SET gcal_dirty = 1').run().changes;
    onChange();
    res.json({ queued: n });
  });

  r.post('/calendar/sync', async (_req, res) => {
    try {
      const result = await syncCalendar(db);
      res.json({ ...result, settings: getSettings(db) });
    } catch (e) {
      res.status(502).json({ error: `Calendar sync failed: ${e.message}` });
    }
  });

  // Weekly tutoring series found on the calendar that aren't in the app yet.
  r.get('/calendar/tutoring', (_req, res) => {
    const events = all("SELECT * FROM calendar_events WHERE is_tutoring = 1 AND start_at >= ? ORDER BY start_at", `${addDays(today(), -7)}T00:00`);
    const rules = all('SELECT r.*, s.name FROM recurring r JOIN students s ON s.id = r.student_id WHERE r.active = 1');
    const series = new Map();
    for (const e of events) {
      const wd = new Date(toMs(e.start_at)).getUTCDay();
      const key = `${e.summary}|${wd}|${e.start_at.slice(11)}`;
      if (!series.has(key)) {
        const parsed = parseTutoringTitle(e.summary);
        const match = rules.find((x) => x.weekday === wd && x.start_time === e.start_at.slice(11));
        series.set(key, {
          key, summary: e.summary, weekday: wd, start_time: e.start_at.slice(11),
          duration_min: minutesBetween(e.start_at, e.end_at), first: e.start_at.slice(0, 10), count: 0,
          name: parsed.name, parent: parsed.parent, imported_as: match ? match.name : null,
        });
      }
      series.get(key).count++;
    }
    res.json([...series.values()].sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time)));
  });

  // Import selected calendar series: reuse a student with the same name or create one.
  r.post('/calendar/import', (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const created = [];
    tx(db, () => {
      for (const it of items) {
        const name = str(it.name, 120);
        const f = ruleFields({ weekday: it.weekday, start_time: it.start_time, duration_min: it.duration_min, starts_on: isDate(it.starts_on) ? it.starts_on : today() });
        if (!name) throw bad('Each import needs a student name');
        let st = it.student_id ? getStudent(int(it.student_id)) : one('SELECT * FROM students WHERE name = ? COLLATE NOCASE', name);
        if (!st) {
          const id = db.prepare('INSERT INTO students (name, parent_name, rate_cents, portal_token) VALUES (?, ?, ?, ?)')
            .run(name, str(it.parent, 120), getSettings(db).default_rate_cents, newToken()).lastInsertRowid;
          st = getStudent(id);
        }
        const exists = one('SELECT id FROM recurring WHERE student_id = ? AND weekday = ? AND start_time = ? AND active = 1', st.id, f.weekday, f.start_time);
        if (exists) continue;
        const info = db.prepare('INSERT INTO recurring (student_id, weekday, start_time, duration_min, starts_on) VALUES (?, ?, ?, ?, ?)')
          .run(st.id, f.weekday, f.start_time, f.duration_min, f.starts_on);
        created.push({ student: st.name, recurring_id: Number(info.lastInsertRowid) });
      }
    });
    materializeRecurring(db);
    res.json({ created });
  });

  return r;
}

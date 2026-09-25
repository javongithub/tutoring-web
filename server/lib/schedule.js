import { getSettings, newToken } from '../db.js';
import { expandIcs, isTutoring } from './ics.js';
import {
  addDays, addMinutes, isDate, nowLocal, overlaps, today, toMs, weekday,
} from './time.js';

const HORIZON_DAYS = 70;
const ACTIVE = "('pending','confirmed','completed','no_show')";

// Make sure every active weekly rule has concrete session rows through the horizon.
// Rows are generated once (UNIQUE(recurring_id, start_at)), so cancelling or logging
// one instance never gets overwritten.
export function materializeRecurring(db, ruleId = null) {
  const start = today();
  const horizon = addDays(start, HORIZON_DAYS);
  const rules = db.prepare(
    `SELECT r.*, s.rate_cents FROM recurring r JOIN students s ON s.id = r.student_id
     WHERE r.active = 1 AND s.active = 1 ${ruleId ? 'AND r.id = ?' : ''}`,
  ).all(...(ruleId ? [ruleId] : []));
  const ins = db.prepare(
    `INSERT OR IGNORE INTO sessions (student_id, recurring_id, slot_key, start_at, end_at, status, source, rate_cents, token)
     VALUES (?, ?, ?, ?, ?, 'confirmed', 'tutor', ?, ?)`,
  );
  for (const r of rules) {
    let d = r.starts_on > start ? r.starts_on : start;
    const last = r.ends_on && r.ends_on < horizon ? r.ends_on : horizon;
    // Back-fill from starts_on if it is in the past (lets you log past weeks).
    if (r.starts_on < start) d = r.starts_on;
    for (; d <= last; d = addDays(d, 1)) {
      if (weekday(d) !== r.weekday) continue;
      const s = `${d}T${r.start_time}`;
      ins.run(r.student_id, r.id, s, s, addMinutes(s, r.duration_min), r.rate_cents, newToken());
    }
  }
}

// Remove future, untouched instances of a rule (before editing/deleting it).
export function clearFutureInstances(db, ruleId) {
  db.prepare(
    `DELETE FROM sessions WHERE recurring_id = ? AND status = 'confirmed' AND start_at > ?
       AND topics = '' AND notes = '' AND next_plan = ''
       AND id NOT IN (SELECT session_id FROM change_requests WHERE status = 'pending')`,
  ).run(ruleId, nowLocal());
}

// Everything occupying the tutor's time in [from, to), labelled for a given viewer.
//   kind 'own'     – the viewing family's own session (shows the student's name)
//   kind 'student' – another family's session  -> "Other student"
//   kind 'busy'    – class, club, gym, anything not tutoring -> "Busy"
export function occupied(db, from, to, viewerStudentId = null, { excludeSessionId = null } = {}) {
  const out = [];
  const sessions = db.prepare(
    `SELECT s.id, s.student_id, s.start_at, s.end_at, s.status, st.name
       FROM sessions s LEFT JOIN students st ON st.id = s.student_id
      WHERE s.start_at < ? AND s.end_at > ? AND s.status IN ${ACTIVE}`,
  ).all(`${to}T00:00`, `${from}T00:00`);
  for (const s of sessions) {
    if (s.id === excludeSessionId) continue;
    const own = viewerStudentId && s.student_id === viewerStudentId;
    out.push({
      start_at: s.start_at, end_at: s.end_at, kind: own ? 'own' : 'student',
      label: own ? s.name : 'Other student', ...(own ? { id: s.id, status: s.status } : {}),
    });
  }

  // Times a family has asked to move to are held until the tutor decides.
  for (const c of db.prepare(
    `SELECT c.new_start_at, c.new_end_at, c.session_id, s.student_id, st.name FROM change_requests c
       JOIN sessions s ON s.id = c.session_id LEFT JOIN students st ON st.id = s.student_id
      WHERE c.status = 'pending' AND c.kind = 'reschedule' AND c.new_start_at < ? AND c.new_end_at > ?`,
  ).all(`${to}T00:00`, `${from}T00:00`)) {
    if (c.session_id === excludeSessionId) continue;
    const own = viewerStudentId && c.student_id === viewerStudentId;
    out.push({
      start_at: c.new_start_at, end_at: c.new_end_at, kind: own ? 'own' : 'student',
      label: own ? `${c.name} (move requested)` : 'Other student', ...(own ? { status: 'requested' } : {}),
    });
  }

  // Any app-managed session (any status) at a time means the app owns that slot; the
  // matching Google Calendar tutoring event is ignored so a cancellation frees it.
  const appStarts = new Set();
  for (const r of db.prepare('SELECT start_at, slot_key FROM sessions WHERE start_at < ? AND end_at > ? AND student_id IS NOT NULL')
    .all(`${addDays(to, 1)}T00:00`, `${addDays(from, -1)}T00:00`)) {
    appStarts.add(r.start_at);
    if (r.slot_key) appStarts.add(r.slot_key);
  }
  for (const e of db.prepare('SELECT * FROM calendar_events WHERE start_at < ? AND end_at > ?')
    .all(`${to}T00:00`, `${from}T00:00`)) {
    if (e.from_app) continue; // our own pushed event echoing back
    if (e.is_tutoring && appStarts.has(e.start_at)) continue;
    out.push({
      start_at: e.start_at, end_at: e.end_at,
      kind: e.is_tutoring ? 'student' : 'busy', label: e.is_tutoring ? 'Other student' : 'Busy',
    });
  }

  for (let d = from; d < to; d = addDays(d, 1)) {
    for (const b of db.prepare('SELECT * FROM blocks WHERE weekday = ?').all(weekday(d))) {
      out.push({ start_at: `${d}T${b.start_time}`, end_at: `${d}T${b.end_time}`, kind: 'busy', label: 'Busy' });
    }
  }
  return out.sort((a, b) => a.start_at.localeCompare(b.start_at));
}

// Bookable slots in [from, to): inside availability windows, after the notice period,
// not overlapping anything occupied. Slots start on the half hour.
export function openSlots(db, from, to, busy = occupied(db, from, to), { ignoreNotice = false } = {}) {
  const st = getSettings(db);
  const earliest = toMs(nowLocal()) + st.min_notice_hours * 3600000;
  const lastDay = addDays(today(), st.booking_weeks_ahead * 7);
  const slots = [];
  for (let d = from; d < to && d <= lastDay; d = addDays(d, 1)) {
    for (const w of db.prepare('SELECT * FROM availability WHERE weekday = ? ORDER BY start_time').all(weekday(d))) {
      const windowEnd = `${d}T${w.end_time}`;
      for (let s = `${d}T${w.start_time}`; addMinutes(s, st.slot_minutes) <= windowEnd; s = addMinutes(s, 30)) {
        const e = addMinutes(s, st.slot_minutes);
        if (!ignoreNotice && toMs(s) < earliest) continue;
        if (busy.some((b) => overlaps(s, e, b.start_at, b.end_at))) continue;
        slots.push({ start_at: s, end_at: e });
      }
    }
  }
  return slots;
}

export async function syncCalendar(db, fetchImpl = fetch) {
  const { ics_url: url } = getSettings(db);
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (!url) {
    db.prepare('DELETE FROM calendar_events').run();
    return { count: 0 };
  }
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Calendar feed returned HTTP ${res.status}`);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('URL did not return an iCal feed');
    const from = addDays(today(), -120);
    const events = expandIcs(text, from, addDays(today(), HORIZON_DAYS));
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM calendar_events').run();
      const ins = db.prepare('INSERT INTO calendar_events (uid, summary, start_at, end_at, is_tutoring, from_app) VALUES (?, ?, ?, ?, ?, ?)');
      for (const e of events) {
        ins.run(e.uid, e.summary, e.start_at, e.end_at, isTutoring(e.summary) ? 1 : 0, e.from_app ? 1 : 0);
      }
      set.run('ics_synced_at', nowLocal());
      set.run('ics_error', '');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { count: events.length };
  } catch (err) {
    set.run('ics_error', String(err.message || err));
    throw err;
  }
}

export const validRange = (from, to) => isDate(from) && isDate(to) && from < to && toMs(to) - toMs(from) <= 62 * 86400000;

// Cancel a pending/confirmed session. Client cancels inside the notice window are
// flagged late and billed if the "charge late cancels" setting is on.
export function cancelSession(db, s, { by, reason = '', charged, late: lateOverride }) {
  const st = getSettings(db);
  const late = by === 'client' ? (lateOverride ?? isLateCancel(db, s.start_at)) : 0;
  const bill = charged !== undefined ? charged : (late && st.charge_late_cancels ? 1 : 0);
  db.prepare(
    "UPDATE sessions SET status='cancelled', cancelled_by=?, cancel_reason=?, cancelled_at=?, late_cancel=?, charged=? WHERE id=?",
  ).run(by, reason, nowLocal(), late, bill, s.id);
}

// Apply an approved change request (or a tutor-initiated move).
export function moveSession(db, s, newStart, newEnd) {
  db.prepare('UPDATE sessions SET start_at = ?, end_at = ? WHERE id = ?').run(newStart, newEnd, s.id);
}

export function isLateCancel(db, startAt, at = nowLocal()) {
  return (toMs(startAt) - toMs(at)) / 3600000 < getSettings(db).cancel_notice_hours ? 1 : 0;
}

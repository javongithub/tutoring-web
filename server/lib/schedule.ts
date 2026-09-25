import { type DB, all, getSettings, newToken, run, setSetting, tx } from '../db.ts';
import type { CalendarEventRow, Flag, Occupied, RuleRow, SessionRow, Slot, WeeklyRow } from '../types.ts';
import { expandIcs, isTutoring } from './ics.ts';
import {
  type DateStr, type DateTimeStr, addDays, addMinutes, isDate, nowLocal, overlaps, today, toMs, weekday,
} from './time.ts';

const HORIZON_DAYS = 70;
const ACTIVE = "('pending','confirmed','completed','no_show')";

export type { Occupied, Slot };

// Make sure every active weekly rule has concrete session rows through the horizon.
// Rows are generated once (UNIQUE(recurring_id, slot_key)), so cancelling, moving or
// logging one instance never gets overwritten.
export function materializeRecurring(db: DB, ruleId: number | null = null): void {
  const start = today();
  const horizon = addDays(start, HORIZON_DAYS);
  const rules = all<RuleRow & { rate_cents: number }>(db,
    `SELECT r.*, s.rate_cents FROM recurring r JOIN students s ON s.id = r.student_id
     WHERE r.active = 1 AND s.active = 1 ${ruleId ? 'AND r.id = ?' : ''}`,
    ...(ruleId ? [ruleId] : []));
  const ins = db.prepare(
    `INSERT OR IGNORE INTO sessions (student_id, recurring_id, slot_key, start_at, end_at, status, source, rate_cents, token)
     VALUES (?, ?, ?, ?, ?, 'confirmed', 'tutor', ?, ?)`,
  );
  for (const r of rules) {
    // Back-fill from starts_on if it is in the past (lets you log past weeks).
    let d: DateStr = r.starts_on;
    const last = r.ends_on && r.ends_on < horizon ? r.ends_on : horizon;
    for (; d <= last; d = addDays(d, 1)) {
      if (weekday(d) !== r.weekday) continue;
      const s = `${d}T${r.start_time}`;
      ins.run(r.student_id, r.id, s, s, addMinutes(s, r.duration_min), r.rate_cents, newToken());
    }
  }
}

// Remove future, untouched instances of a rule (before editing/deleting it).
export function clearFutureInstances(db: DB, ruleId: number): void {
  run(db,
    `DELETE FROM sessions WHERE recurring_id = ? AND status = 'confirmed' AND start_at > ?
       AND topics = '' AND notes = '' AND next_plan = ''
       AND id NOT IN (SELECT session_id FROM change_requests WHERE status = 'pending')`,
    ruleId, nowLocal());
}

// Everything occupying the tutor's time in [from, to), labelled for a given viewer.
//   kind 'own'     – the viewing family's own session (shows the student's name)
//   kind 'student' – another family's session  -> "Other student"
//   kind 'busy'    – class, club, gym, anything not tutoring -> "Busy"
export function occupied(
  db: DB, from: DateStr, to: DateStr, viewerStudentId: number | null = null,
  { excludeSessionId = null }: { excludeSessionId?: number | null } = {},
): Occupied[] {
  const out: Occupied[] = [];
  const range = [`${to}T00:00`, `${from}T00:00`];
  const sessions = all<Pick<SessionRow, 'id' | 'student_id' | 'start_at' | 'end_at' | 'status'> & { name: string | null }>(db,
    `SELECT s.id, s.student_id, s.start_at, s.end_at, s.status, st.name
       FROM sessions s LEFT JOIN students st ON st.id = s.student_id
      WHERE s.start_at < ? AND s.end_at > ? AND s.status IN ${ACTIVE}`, ...range);
  for (const s of sessions) {
    if (s.id === excludeSessionId) continue;
    const own = viewerStudentId !== null && s.student_id === viewerStudentId;
    out.push({
      start_at: s.start_at, end_at: s.end_at, kind: own ? 'own' : 'student',
      label: own ? s.name ?? '' : 'Other student', ...(own ? { id: s.id, status: s.status } : {}),
    });
  }

  // Times a family has asked to move to are held until the tutor decides.
  const holds = all<{ new_start_at: string; new_end_at: string; session_id: number; student_id: number | null; name: string | null }>(db,
    `SELECT c.new_start_at, c.new_end_at, c.session_id, s.student_id, st.name FROM change_requests c
       JOIN sessions s ON s.id = c.session_id LEFT JOIN students st ON st.id = s.student_id
      WHERE c.status = 'pending' AND c.kind = 'reschedule' AND c.new_start_at < ? AND c.new_end_at > ?`, ...range);
  for (const c of holds) {
    if (c.session_id === excludeSessionId) continue;
    const own = viewerStudentId !== null && c.student_id === viewerStudentId;
    out.push({
      start_at: c.new_start_at, end_at: c.new_end_at, kind: own ? 'own' : 'student',
      label: own ? `${c.name} (move requested)` : 'Other student', ...(own ? { status: 'requested' } : {}),
    });
  }

  // Any app-managed session (any status) at a time means the app owns that slot; the
  // matching Google Calendar tutoring event is ignored so a cancellation frees it.
  const appStarts = new Set<string>();
  for (const r of all<{ start_at: string; slot_key: string | null }>(db,
    'SELECT start_at, slot_key FROM sessions WHERE start_at < ? AND end_at > ? AND student_id IS NOT NULL',
    `${addDays(to, 1)}T00:00`, `${addDays(from, -1)}T00:00`)) {
    appStarts.add(r.start_at);
    if (r.slot_key) appStarts.add(r.slot_key);
  }
  for (const e of all<CalendarEventRow>(db, 'SELECT * FROM calendar_events WHERE start_at < ? AND end_at > ?', ...range)) {
    if (e.from_app) continue; // our own pushed event echoing back
    if (e.is_tutoring && appStarts.has(e.start_at)) continue;
    out.push({
      start_at: e.start_at, end_at: e.end_at,
      kind: e.is_tutoring ? 'student' : 'busy', label: e.is_tutoring ? 'Other student' : 'Busy',
    });
  }

  for (let d = from; d < to; d = addDays(d, 1)) {
    for (const b of all<WeeklyRow>(db, 'SELECT * FROM blocks WHERE weekday = ?', weekday(d))) {
      out.push({ start_at: `${d}T${b.start_time}`, end_at: `${d}T${b.end_time}`, kind: 'busy', label: 'Busy' });
    }
  }
  return out.sort((a, b) => a.start_at.localeCompare(b.start_at));
}

// Bookable slots in [from, to): inside availability windows, after the notice period,
// not overlapping anything occupied. Slots start on the half hour.
export function openSlots(
  db: DB, from: DateStr, to: DateStr, busy: Occupied[] = occupied(db, from, to),
  { ignoreNotice = false }: { ignoreNotice?: boolean } = {},
): Slot[] {
  const st = getSettings(db);
  const earliest = toMs(nowLocal()) + st.min_notice_hours * 3600000;
  const lastDay = addDays(today(), st.booking_weeks_ahead * 7);
  const slots: Slot[] = [];
  for (let d = from; d < to && d <= lastDay; d = addDays(d, 1)) {
    for (const w of all<WeeklyRow>(db, 'SELECT * FROM availability WHERE weekday = ? ORDER BY start_time', weekday(d))) {
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

export async function syncCalendar(db: DB, fetchImpl: typeof fetch = fetch): Promise<{ count: number }> {
  const { ics_url: url } = getSettings(db);
  if (!url) {
    run(db, 'DELETE FROM calendar_events');
    return { count: 0 };
  }
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Calendar feed returned HTTP ${res.status}`);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('URL did not return an iCal feed');
    const events = expandIcs(text, addDays(today(), -120), addDays(today(), HORIZON_DAYS));
    tx(db, () => {
      run(db, 'DELETE FROM calendar_events');
      const ins = db.prepare('INSERT INTO calendar_events (uid, summary, start_at, end_at, is_tutoring, from_app) VALUES (?, ?, ?, ?, ?, ?)');
      for (const e of events) ins.run(e.uid, e.summary, e.start_at, e.end_at, isTutoring(e.summary) ? 1 : 0, e.from_app ? 1 : 0);
      setSetting(db, 'ics_synced_at', nowLocal());
      setSetting(db, 'ics_error', '');
    });
    return { count: events.length };
  } catch (err) {
    setSetting(db, 'ics_error', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export const validRange = (from: unknown, to: unknown): boolean =>
  isDate(from) && isDate(to) && from < to && toMs(to) - toMs(from) <= 62 * 86400000;

export function isLateCancel(db: DB, startAt: DateTimeStr, at: DateTimeStr = nowLocal()): Flag {
  return (toMs(startAt) - toMs(at)) / 3600000 < getSettings(db).cancel_notice_hours ? 1 : 0;
}

// Cancel a pending/confirmed session. Client cancels inside the notice window are
// flagged late and billed if the "charge late cancels" setting is on.
export function cancelSession(
  db: DB, s: Pick<SessionRow, 'id' | 'start_at'>,
  { by, reason = '', charged, late: lateOverride }: { by: 'client' | 'tutor'; reason?: string; charged?: Flag; late?: Flag },
): void {
  const st = getSettings(db);
  const late: Flag = by === 'client' ? (lateOverride ?? isLateCancel(db, s.start_at)) : 0;
  const bill: Flag = charged !== undefined ? charged : (late && st.charge_late_cancels ? 1 : 0);
  run(db,
    "UPDATE sessions SET status='cancelled', cancelled_by=?, cancel_reason=?, cancelled_at=?, late_cancel=?, charged=? WHERE id=?",
    by, reason, nowLocal(), late, bill, s.id);
}

// Apply an approved change request (or a tutor-initiated move).
export function moveSession(db: DB, s: Pick<SessionRow, 'id'>, newStart: DateTimeStr, newEnd: DateTimeStr): void {
  run(db, 'UPDATE sessions SET start_at = ?, end_at = ? WHERE id = ?', newStart, newEnd, s.id);
}

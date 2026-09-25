// Waitlist: when a bookable time opens (a cancellation, a moved session, new availability),
// email everyone waiting whose preferred days match, once per opening.
import { type DB, all, getSettings, run } from '../db.ts';
import type { WaitlistRow } from '../types.ts';
import type { Notifier } from './notify.ts';
import { openSlots } from './schedule.ts';
import { addDays, fmtWhen, nowLocal, today, weekday, weekStart } from './time.ts';

const HORIZON_DAYS = 14;

export const parseWeekdays = (s: string): number[] => (s ? s.split(',').map(Number).filter((n) => n >= 0 && n <= 6) : []);

export function announceOpenings(db: DB, notify: Notifier): { announced: number; notified: number } {
  const st = getSettings(db);
  const from = today();
  const to = addDays(from, Math.min(HORIZON_DAYS, st.booking_weeks_ahead * 7));
  const open = openSlots(db, from, to);
  const openSet = new Set(open.map((s) => s.start_at));

  // Forget announcements for slots that were taken (or passed) so they can be re-announced.
  const announced = all<{ start_at: string }>(db, 'SELECT start_at FROM waitlist_announced').map((r) => r.start_at);
  for (const a of announced) if (!openSet.has(a)) run(db, 'DELETE FROM waitlist_announced WHERE start_at = ?', a);

  const already = new Set(announced.filter((a) => openSet.has(a)));
  const fresh = open.filter((s) => !already.has(s.start_at));
  if (!fresh.length) return { announced: 0, notified: 0 };

  const mark = db.prepare('INSERT OR IGNORE INTO waitlist_announced (start_at, announced_at) VALUES (?, ?)');
  const now = nowLocal();
  for (const s of fresh) mark.run(s.start_at, now);

  const waiting = all<WaitlistRow>(db, "SELECT * FROM waitlist WHERE status = 'active' ORDER BY created_at");
  const touched = db.prepare('UPDATE waitlist SET last_notified_at = ? WHERE id = ?');
  let notified = 0;
  for (const w of waiting) {
    const days = parseWeekdays(w.weekdays);
    const match = fresh.filter((s) => !days.length || days.includes(weekday(s.start_at)));
    if (!match.length) continue;
    const list = match.slice(0, 6).map((s) => `  • ${fmtWhen(s.start_at, s.end_at)}`).join('\n');
    notify.family(
      w.email,
      match.length === 1 ? `A tutoring slot opened: ${fmtWhen(match[0].start_at)}` : `${match.length} tutoring slots opened`,
      `Hi ${w.parent_name}! You're on the waitlist for ${w.student_name}, and ${match.length === 1 ? 'a time just opened' : 'some times just opened'}:\n\n${list}\n\n`
        + `First to request gets it. Book here: ${notify.base()}/?week=${weekStart(match[0].start_at)}\n\n`
        + 'No longer need a spot? Leave the waitlist:',
      { path: `/waitlist/${w.token}`, force: true },
    );
    touched.run(now, w.id);
    notified++;
  }
  if (notified) {
    notify.tutor(`Waitlist: ${fresh.length} opening${fresh.length > 1 ? 's' : ''} announced`,
      `Emailed ${notified} waiting famil${notified > 1 ? 'ies' : 'y'} about ${fresh.map((s) => fmtWhen(s.start_at)).slice(0, 4).join(', ')}.`,
      { path: '/admin/waitlist' });
  }
  return { announced: fresh.length, notified };
}

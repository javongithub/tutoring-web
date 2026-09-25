// All times are stored as naive local wall-clock strings "YYYY-MM-DDTHH:MM" in the
// tutor's timezone. Arithmetic is done by treating them as UTC so DST never shifts
// a 4:30pm session to 3:30pm.

export const TZ = process.env.TZ_NAME || 'America/Los_Angeles';

const pad = (n) => String(n).padStart(2, '0');

export function toMs(s) {
  const [d, t = '00:00'] = s.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  return Date.UTC(y, m - 1, day, hh, mm);
}

export function fromMs(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export const addMinutes = (s, min) => fromMs(toMs(s) + min * 60000);
export const addDays = (dateStr, n) => fromMs(toMs(dateStr) + n * 86400000).slice(0, 10);
export const weekday = (dateStr) => new Date(toMs(dateStr.slice(0, 10))).getUTCDay();
export const minutesBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / 60000);

export function nowLocal(tz = TZ) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export const today = () => nowLocal().slice(0, 10);

// Monday of the week containing dateStr.
export function weekStart(dateStr) {
  const wd = weekday(dateStr);
  return addDays(dateStr, wd === 0 ? -6 : 1 - wd);
}

export const isDateTime = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && !Number.isNaN(toMs(s));
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

// Human-friendly "Fri, Oct 2, 5:30–6:30pm" for emails and notifications.
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtClock(s) {
  const [h, m] = s.slice(-5).split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${pad(m)}` : ''}${h < 12 ? 'am' : 'pm'}`;
}
export function fmtWhen(start, end) {
  const d = new Date(toMs(start));
  const date = `${DAY[d.getUTCDay()]}, ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return end ? `${date}, ${fmtClock(start)}–${fmtClock(end)}` : `${date}, ${fmtClock(start)}`;
}

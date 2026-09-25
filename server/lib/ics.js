// Minimal iCalendar (RFC 5545) reader for a Google Calendar "secret address in iCal format".
// Supports what Google emits for normal calendars: timed events, TZID/UTC times,
// RRULE (DAILY/WEEKLY with BYDAY, INTERVAL, UNTIL, COUNT), EXDATE, and
// RECURRENCE-ID overrides (moved or cancelled single instances).
import { TZ, fromMs } from './time.js';

const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return null;
  const [name, ...paramParts] = line.slice(0, idx).split(';');
  const params = Object.fromEntries(paramParts.map((p) => p.split('=')));
  return { name: name.toUpperCase(), params, value: line.slice(idx + 1) };
}

const unescape = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

// Offset (ms) of zone `tz` from UTC at instant `ms`.
function tzOffset(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

// Convert an ICS date-time value to a local wall-clock string in the app timezone.
function toLocal(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, hh = '00', mi = '00', ss = '00', z] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
  let utc;
  if (z) utc = wall;
  else {
    const tz = params.TZID || TZ;
    if (tz === TZ) return fromMs(wall); // already our wall clock
    utc = wall - tzOffset(wall, tz);
  }
  return fromMs(utc + tzOffset(utc, TZ));
}

function parseRRule(v) {
  const r = Object.fromEntries(v.split(';').map((kv) => kv.split('=')));
  return {
    freq: r.FREQ,
    interval: Number(r.INTERVAL || 1),
    byday: r.BYDAY ? r.BYDAY.split(',').map((d) => DAYS[d.slice(-2)]) : null,
    until: r.UNTIL || null,
    count: r.COUNT ? Number(r.COUNT) : null,
  };
}

export function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const raw of unfold(text)) {
    if (raw === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (raw === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const l = parseLine(raw);
    if (!l) continue;
    switch (l.name) {
      case 'UID': cur.uid = l.value; break;
      case 'SUMMARY': cur.summary = unescape(l.value); break;
      case 'STATUS': cur.status = l.value; break;
      case 'DESCRIPTION': cur.fromApp = /tutoring-app:session:/.test(l.value); break;
      case 'TRANSP': cur.transp = l.value; break;
      case 'DTSTART': cur.allDay = l.params.VALUE === 'DATE'; cur.start = toLocal(l.value, l.params); break;
      case 'DTEND': cur.end = toLocal(l.value, l.params); break;
      case 'RRULE': cur.rrule = parseRRule(l.value); break;
      case 'EXDATE': for (const v of l.value.split(',')) cur.exdates.push(toLocal(v, l.params)); break;
      case 'RECURRENCE-ID': cur.recurrenceId = toLocal(l.value, l.params); break;
      default:
    }
  }
  return events;
}

const toMsLocal = (s) => Date.parse(`${s}:00Z`);

// Expand events into concrete instances overlapping [from, to) (local date strings).
export function expandIcs(text, from, to) {
  const events = parseIcs(text).filter((e) => e.start && e.end && !e.allDay);
  const overrides = new Map(); // uid -> Map(recurrenceId -> event)
  for (const e of events.filter((x) => x.recurrenceId)) {
    if (!overrides.has(e.uid)) overrides.set(e.uid, new Map());
    overrides.get(e.uid).set(e.recurrenceId, e);
  }
  const fromMsV = toMsLocal(`${from}T00:00`);
  const toMsV = toMsLocal(`${to}T00:00`);
  const out = [];
  const push = (e, start, end) => {
    if (e.status === 'CANCELLED' || e.transp === 'TRANSPARENT') return;
    if (toMsLocal(end) <= fromMsV || toMsLocal(start) >= toMsV) return;
    out.push({ uid: e.uid, summary: e.summary || '', start_at: start, end_at: end, from_app: !!e.fromApp });
  };

  for (const e of events.filter((x) => !x.recurrenceId)) {
    const durMs = toMsLocal(e.end) - toMsLocal(e.start);
    const ov = overrides.get(e.uid) || new Map();
    const emit = (start) => {
      if (e.exdates.includes(start)) return;
      if (ov.has(start)) { const o = ov.get(start); push(o, o.start, o.end); return; }
      push(e, start, fromMs(toMsLocal(start) + durMs));
    };
    if (!e.rrule || !['DAILY', 'WEEKLY'].includes(e.rrule.freq)) { emit(e.start); continue; }

    const { freq, interval, until, count } = e.rrule;
    const untilLocal = until ? toLocal(until, until.endsWith('Z') ? {} : { TZID: TZ }) : null;
    const time = e.start.slice(11);
    const startDay = toMsLocal(`${e.start.slice(0, 10)}T00:00`);
    const startWd = new Date(startDay).getUTCDay();
    const byday = e.rrule.byday || [startWd];
    // Monday-based week of the first occurrence (Google's default WKST=MO).
    const week0 = startDay - (((startWd + 6) % 7) * 86400000);
    let n = 0;
    for (let day = startDay; day < toMsV; day += 86400000) {
      const wd = new Date(day).getUTCDay();
      if (freq === 'DAILY') {
        if (Math.round((day - startDay) / 86400000) % interval !== 0) continue;
      } else {
        const weekIdx = Math.floor((day - week0) / (7 * 86400000));
        if (weekIdx % interval !== 0 || !byday.includes(wd)) continue;
      }
      const start = `${fromMs(day).slice(0, 10)}T${time}`;
      if (untilLocal && start > untilLocal) break;
      if (count && n >= count) break;
      n++;
      emit(start);
    }
  }
  // Orphan overrides (instance moved in from outside the series window).
  return out.sort((a, b) => a.start_at.localeCompare(b.start_at));
}

// "Casey Tutoring — Ms. Rivera (said on 9/8)" -> { name: 'Casey', parent: 'Ms. Rivera' }
export function parseTutoringTitle(summary) {
  if (!/tutor/i.test(summary)) return null;
  let s = summary.replace(/\(.*?\)/g, ' ');
  let parent = '';
  const parts = s.split(/\s[—–-]\s/);
  s = parts[0];
  const rest = parts.slice(1).join(' ').trim();
  if (/^(ms|mr|mrs|dr)\.?\s/i.test(rest)) parent = rest;
  const name = s.replace(/tutoring|tutor/gi, ' ').replace(/\bwith\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return { name: name || summary.trim(), parent };
}

export const isTutoring = (summary) => /tutor/i.test(summary || '');

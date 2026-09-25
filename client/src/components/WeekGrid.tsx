import { DAYS, addDays, fmtRange, fmtTime, minutesOf } from '../util.ts';

const PX_PER_HOUR = 52;

// Google-Calendar-style week. `items` are drawn blocks; `slots` are clickable open times.
// item: { start_at, end_at, title, sub, kind, onClick }
export default function WeekGrid({ start, items = [], slots = [], onSlot, today, minHour, maxHour, selected }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const all = [...items, ...slots];
  const lo = Math.min(minHour ?? 15, ...all.map((x) => Math.floor(minutesOf(x.start_at) / 60)));
  const hi = Math.max(maxHour ?? 20, ...all.map((x) => Math.ceil(minutesOf(x.end_at.slice(0, 10) > x.start_at.slice(0, 10) ? '23:59' : x.end_at) / 60)));
  const hours = Array.from({ length: hi - lo }, (_, i) => lo + i);
  const top = (s) => ((minutesOf(s) - lo * 60) / 60) * PX_PER_HOUR;
  const height = (a, b) => Math.max(18, ((minutesOf(b) - minutesOf(a)) / 60) * PX_PER_HOUR - 2);

  return (
    <div className="week-scroll">
      <div className="week" style={{ '--hours': hours.length, '--pxh': `${PX_PER_HOUR}px` }}>
        <div className="week-corner" />
        {days.map((d) => (
          <div key={d} className={`week-dayhead ${d === today ? 'is-today' : ''}`}>
            <span>{DAYS[new Date(`${d}T00:00Z`).getUTCDay()]}</span>
            <strong>{Number(d.slice(8))}</strong>
          </div>
        ))}
        <div className="week-hours">
          {hours.map((h) => <div key={h} className="week-hour">{fmtTime(`${String(h).padStart(2, '0')}:00`)}</div>)}
        </div>
        {days.map((d) => (
          <div key={d} className="week-col">
            {hours.map((h) => <div key={h} className="week-line" />)}
            {slots.filter((s) => s.start_at.startsWith(d)).map((s) => (
              <button
                key={s.start_at}
                className={`ev ev-slot ${selected === s.start_at ? 'is-selected' : ''}`}
                style={{ top: top(s.start_at), height: height(s.start_at, s.end_at) }}
                onClick={() => onSlot?.(s)}
                aria-label={`Open ${fmtRange(s.start_at, s.end_at)}`}
              >
                <span className="ev-time">{fmtTime(s.start_at)}</span> Open
              </button>
            ))}
            {items.filter((it) => it.start_at.startsWith(d)).map((it, i, dayItems) => {
              const El = it.onClick ? 'button' : 'div';
              // A clickable session overlapping a background (non-clickable) block is indented
              // so the block behind it stays visible and the session stays clickable.
              const overlapsBg = it.onClick && dayItems.some((o) => !o.onClick && o.start_at < it.end_at && it.start_at < o.end_at);
              return (
                <El
                  key={`${it.start_at}-${i}`}
                  className={`ev ev-${it.kind}`}
                  style={{ top: top(it.start_at), height: height(it.start_at, it.end_at), ...(overlapsBg ? { left: '14px' } : {}) }}
                  onClick={it.onClick}
                  title={`${it.title} · ${fmtRange(it.start_at, it.end_at)}`}
                >
                  <span className="ev-title">{it.title}</span>
                  <span className="ev-time">{fmtRange(it.start_at, it.end_at)}</span>
                  {it.sub && <span className="ev-sub">{it.sub}</span>}
                </El>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function WeekNav({ start, onChange, min, max }) {
  const end = addDays(start, 6);
  const label = `${new Date(`${start}T00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${new Date(`${end}T00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
  return (
    <div className="week-nav">
      <button className="btn" onClick={() => onChange(addDays(start, -7))} disabled={min && start <= min} aria-label="Previous week">‹</button>
      <strong>{label}</strong>
      <button className="btn" onClick={() => onChange(addDays(start, 7))} disabled={max && addDays(start, 7) > max} aria-label="Next week">›</button>
    </div>
  );
}

export function Legend({ items }) {
  return (
    <div className="legend">
      {items.map(([kind, label]) => <span key={kind}><i className={`ev-${kind}`} />{label}</span>)}
    </div>
  );
}

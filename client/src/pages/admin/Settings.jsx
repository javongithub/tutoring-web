import { useEffect, useState } from 'react';
import { get, post, put } from '../../api.js';
import { DAYS, DAYS_LONG, copy, fmtTime, useLoad } from '../../util.js';
import { ErrorText, Loading, useAction } from '../../components/ui.jsx';

export default function Settings() {
  const { data, error, reload } = useLoad(() => get('/admin/settings'));
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="page">
      <h1>Settings</h1>
      <Notifications data={data} onChanged={reload} />
      <Payments s={data.settings} onSaved={reload} />
      <GoogleCalendar data={data} onChanged={reload} />
      <General s={data.settings} onSaved={reload} />
      <WeeklyRows
        title="When families can book"
        hint="Open slots on your public page come from these windows, minus anything already on your schedule or Google Calendar."
        rows={data.availability} path="/admin/availability" onSaved={reload}
      />
      <WeeklyRows
        title="Other weekly commitments"
        hint="Classes, clubs, etc. that aren't on your synced Google Calendar. Families only ever see “Busy”."
        rows={data.blocks} path="/admin/blocks" withLabel onSaved={reload}
      />
    </div>
  );
}

function General({ s, onSaved }) {
  const [f, setF] = useState({ ...s, rate: s.default_rate_cents / 100 });
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.value });
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      await put('/admin/settings', {
        tutor_name: f.tutor_name, default_rate_cents: Math.round(Number(f.rate) * 100), slot_minutes: f.slot_minutes,
        min_notice_hours: f.min_notice_hours, booking_weeks_ahead: f.booking_weeks_ahead,
        cancel_notice_hours: f.cancel_notice_hours, charge_late_cancels: f.charge_late_cancels,
      });
      onSaved();
    });
  };
  return (
    <section className="card">
      <h2>Booking & payment</h2>
      <form className="form" onSubmit={save}>
        <div className="grid2">
          <label className="field"><span>Name on public page</span><input value={f.tutor_name} onChange={set('tutor_name')} /></label>
          <label className="field"><span>Default rate per session ($)</span><input type="number" min={0} step="0.01" value={f.rate} onChange={set('rate')} /></label>
          <label className="field"><span>Session length (minutes)</span><input type="number" min={15} step={15} value={f.slot_minutes} onChange={set('slot_minutes')} /></label>
          <label className="field"><span>Minimum notice to book (hours)</span><input type="number" min={0} value={f.min_notice_hours} onChange={set('min_notice_hours')} /></label>
          <label className="field"><span>How far ahead families can book (weeks)</span><input type="number" min={1} max={26} value={f.booking_weeks_ahead} onChange={set('booking_weeks_ahead')} /></label>
          <label className="field"><span>Cancellation / reschedule policy (hours)</span><input type="number" min={0} value={f.cancel_notice_hours} onChange={set('cancel_notice_hours')} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={!!f.charge_late_cancels} onChange={set('charge_late_cancels')} /> Charge for late cancellations (inside the policy window) by default. Families are told this before they request, and you can override it each time</label>
        <ErrorText error={error} />
        <button className="btn primary" disabled={busy}>Save</button>
      </form>
    </section>
  );
}

function WeeklyRows({ title, hint, rows: initial, path, withLabel, onSaved }) {
  const [rows, setRows] = useState(initial);
  useEffect(() => setRows(initial), [initial]);
  const { busy, error, run } = useAction();
  const upd = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="hint">{hint}</p>
      {rows.map((r, i) => (
        <div key={i} className="inline-form">
          {withLabel && <input placeholder="Label (private)" value={r.label || ''} onChange={(e) => upd(i, 'label', e.target.value)} />}
          <select value={r.weekday} onChange={(e) => upd(i, 'weekday', Number(e.target.value))} aria-label="Day">
            {DAYS_LONG.map((d, j) => <option key={d} value={j}>{d}</option>)}
          </select>
          <input type="time" value={r.start_time} onChange={(e) => upd(i, 'start_time', e.target.value)} aria-label="From" />
          <span>to</span>
          <input type="time" value={r.end_time} onChange={(e) => upd(i, 'end_time', e.target.value)} aria-label="To" />
          <button className="icon-btn" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove">×</button>
        </div>
      ))}
      <ErrorText error={error} />
      <div className="actions left">
        <button className="btn" onClick={() => setRows([...rows, { weekday: 1, start_time: '15:30', end_time: '20:30', label: '' }])}>+ Add row</button>
        <button className="btn primary" disabled={busy} onClick={() => run(async () => { await put(path, rows); onSaved(); })}>Save</button>
      </div>
    </section>
  );
}

function GoogleCalendar({ data, onChanged }) {
  const s = data.settings;
  const [ics, setIcs] = useState(s.ics_url);
  const [calId, setCalId] = useState(s.gcal_calendar_id);
  const [copied, setCopied] = useState(false);
  const act = useAction();
  const feedUrl = `${window.location.origin}/api/public/feed/${s.feed_token}.ics`;

  return (
    <section className="card">
      <h2>Google Calendar sync</h2>

      <h3>1. Google Calendar → this app</h3>
      <p className="hint">
        Makes everything on your Google Calendar block booking. Families see it only as &ldquo;Busy&rdquo; or &ldquo;Other student&rdquo; (events with &ldquo;tutoring&rdquo; in the title).
        In Google Calendar: <em>Settings → your calendar → Integrate calendar → Secret address in iCal format</em>. Paste it here. It re-syncs every 15 minutes.
      </p>
      <div className="inline-form">
        <input type="url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" value={ics} onChange={(e) => setIcs(e.target.value)} style={{ flex: 1 }} />
        <button className="btn primary" disabled={act.busy} onClick={() => act.run(async () => { await put('/admin/settings', { ics_url: ics }); if (ics) await post('/admin/calendar/sync'); onChanged(); })}>Save & sync</button>
      </div>
      <p className="small muted">
        {s.ics_synced_at ? `Last synced ${s.ics_synced_at.replace('T', ' ')}.` : 'Not synced yet.'}
        {s.ics_error && <span className="error"> Error: {s.ics_error}</span>}
      </p>
      {s.ics_url && <ImportTutoring />}

      <h3>2. This app → Google Calendar (instant)</h3>
      {data.gcal_service_account ? (
        <>
          <p className="hint">
            In Google Calendar, share your calendar with <code>{data.gcal_service_account}</code> and pick &ldquo;Make changes to events&rdquo;. Then enter your calendar ID (usually your Gmail address).
            New, moved and cancelled sessions show up in Google Calendar within seconds.
          </p>
          <div className="inline-form">
            <input placeholder="you@gmail.com" value={calId} onChange={(e) => setCalId(e.target.value)} style={{ flex: 1 }} />
            <button className="btn primary" disabled={act.busy} onClick={() => act.run(async () => { await put('/admin/settings', { gcal_calendar_id: calId }); await post('/admin/calendar/push-all'); onChanged(); })}>Save & push</button>
          </div>
          <p className="small muted">
            {s.gcal_synced_at ? `Last push ${new Date(s.gcal_synced_at).toLocaleString()}.` : 'Nothing pushed yet.'}
            {s.gcal_error && <span className="error"> Error: {s.gcal_error}</span>}
          </p>
          <p className="hint">After this is on, delete your old repeating &ldquo;… Tutoring&rdquo; events in Google Calendar so you don&rsquo;t see doubles. The app now owns them.</p>
        </>
      ) : (
        <p className="hint">Not set up. Set <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> on the server (see README), then restart.</p>
      )}
      <details>
        <summary className="small">No-setup alternative: subscribe to a feed (Google refreshes every few hours)</summary>
        <p className="hint">In Google Calendar: <em>Other calendars → + → From URL</em>, paste this private link:</p>
        <div className="inline-form">
          <input readOnly value={feedUrl} style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={async () => setCopied(await copy(feedUrl))}>{copied ? 'Copied!' : 'Copy'}</button>
          <button className="btn subtle" onClick={() => window.confirm('Make a new feed link? The old one stops working.') && act.run(async () => { await post('/admin/calendar/rotate-feed'); onChanged(); })}>New link</button>
        </div>
      </details>
      <ErrorText error={act.error} />
    </section>
  );
}

// Weekly "… Tutoring" series found on Google Calendar that aren't students in the app yet.
function ImportTutoring() {
  const { data, error, reload } = useLoad(() => get('/admin/calendar/tutoring'));
  const [names, setNames] = useState({});
  const [picked, setPicked] = useState({});
  const act = useAction();
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const fresh = data.filter((x) => !x.imported_as && x.count > 1);
  if (fresh.length === 0) return <p className="small muted">All weekly tutoring on your Google Calendar is in the app.</p>;
  const doImport = () => act.run(async () => {
    const items = fresh.filter((x) => picked[x.key] ?? true).map((x) => ({
      name: names[x.key] ?? x.name, parent: x.parent, weekday: x.weekday, start_time: x.start_time, duration_min: x.duration_min,
    }));
    await post('/admin/calendar/import', { items });
    reload();
  });
  return (
    <div className="import">
      <p><strong>Found {fresh.length} weekly tutoring series on your calendar.</strong> Import them as students with weekly sessions (same name = same student):</p>
      {fresh.map((x) => (
        <label key={x.key} className="inline-form">
          <input type="checkbox" checked={picked[x.key] ?? true} onChange={(e) => setPicked({ ...picked, [x.key]: e.target.checked })} />
          <input value={names[x.key] ?? x.name} onChange={(e) => setNames({ ...names, [x.key]: e.target.value })} aria-label="Student name" style={{ width: 160 }} />
          <span className="small">{DAYS[x.weekday]} {fmtTime(x.start_time)} · {x.duration_min}m <span className="muted">— “{x.summary}”</span></span>
        </label>
      ))}
      <ErrorText error={act.error} />
      <button className="btn primary" disabled={act.busy} onClick={doImport}>Import selected</button>
    </div>
  );
}

const randomTopic = () => `tutoring-${Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14)}`;

function Notifications({ data, onChanged }) {
  const s = data.settings;
  const [f, setF] = useState({
    notify_email: s.notify_email, ntfy_url: s.ntfy_url, email_families: s.email_families,
    reminders: s.reminders, reminder_hour: s.reminder_hour, public_url: s.public_url,
  });
  const [test, setTest] = useState(null);
  const act = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.value });
  const save = () => act.run(async () => { await put('/admin/settings', f); onChanged(); });
  const sendTest = () => act.run(async () => {
    await put('/admin/settings', f);
    setTest(await post('/admin/notify/test'));
    onChanged();
  });
  const failed = data.outbox.filter((m) => !m.sent_at && m.last_error);

  return (
    <section className="card">
      <h2>Notifications</h2>

      <h3>Phone alerts (free, instant)</h3>
      <p className="hint">
        1. Install the free <strong>ntfy</strong> app (<a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noreferrer">iPhone</a> /{' '}
        <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noreferrer">Android</a>).
        2. Click <em>Make my link</em>, then save. 3. In the app, tap <strong>+</strong> and subscribe to the topic after <code>ntfy.sh/</code>.
        New bookings and cancel/move requests pop up on your lock screen. Tap one to open the dashboard.
        Keep the topic secret, since anyone who knows it can read your alerts.
      </p>
      <div className="inline-form">
        <input placeholder="https://ntfy.sh/your-secret-topic" value={f.ntfy_url} onChange={set('ntfy_url')} style={{ flex: 1 }} />
        {!f.ntfy_url && <button className="btn" onClick={() => setF({ ...f, ntfy_url: `https://ntfy.sh/${randomTopic()}` })}>Make my link</button>}
      </div>
      {f.ntfy_url && <p className="small">Subscribe to topic: <code>{f.ntfy_url.replace(/^https:\/\/[^/]+\//, '')}</code></p>}

      <h3>Email</h3>
      {!data.email_enabled ? (
        <p className="notice warn">Email is off. Set <code>SMTP_USER</code> / <code>SMTP_PASS</code> on the server (a Gmail app password works, see README), then restart. Phone alerts work without it.</p>
      ) : (
        <>
          <label className="field"><span>Email me about requests at</span><input type="email" placeholder="you@gmail.com" value={f.notify_email} onChange={set('notify_email')} /></label>
          <label className="check"><input type="checkbox" checked={!!f.email_families} onChange={set('email_families')} /> Email families when a request is received, confirmed or declined, and when a change is approved or declined</label>
          <label className="check">
            <input type="checkbox" checked={!!f.reminders} onChange={set('reminders')} /> Email families a reminder the evening before, at
            <select value={f.reminder_hour} onChange={set('reminder_hour')} aria-label="Reminder time">
              {[15, 16, 17, 18, 19, 20, 21].map((h) => <option key={h} value={h}>{fmtTime(`${h}:00`)}</option>)}
            </select>
          </label>
        </>
      )}
      <label className="field"><span>Your site&rsquo;s public address (used for links in alerts and emails)</span>
        <input placeholder={window.location.origin} value={f.public_url} onChange={set('public_url')} />
      </label>

      <ErrorText error={act.error} />
      <div className="actions left">
        <button className="btn primary" disabled={act.busy} onClick={save}>Save</button>
        <button className="btn" disabled={act.busy || (!f.ntfy_url && !f.notify_email)} onClick={sendTest}>Save & send test alert</button>
      </div>
      {test && (
        <p className={`notice ${test.last.every((m) => m.sent_at) ? 'ok' : 'warn'}`}>
          {test.last.map((m) => `${m.channel === 'push' ? 'Phone' : 'Email'}: ${m.sent_at ? 'sent ✓' : `failed (${m.last_error})`}`).join(' · ')}
        </p>
      )}
      {failed.length > 0 && (
        <details>
          <summary className="small error">{failed.length} notification(s) failing</summary>
          <ul className="small">{failed.map((m) => <li key={m.id}>{m.subject} → {m.to_addr}: {m.last_error} (tries: {m.attempts})</li>)}</ul>
        </details>
      )}
    </section>
  );
}

function Payments({ s, onSaved }) {
  const [f, setF] = useState({ venmo_handle: s.venmo_handle, zelle_contact: s.zelle_contact, payment_note: s.payment_note, auto_invoice: s.auto_invoice });
  const act = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.value });
  return (
    <section className="card">
      <h2>Payments &amp; invoices</h2>
      <p className="hint">Shown on every invoice. Venmo and Zelle have no fees (card processors take about 3%).</p>
      <div className="grid2">
        <label className="field"><span>Venmo username</span><input placeholder="your-venmo" value={f.venmo_handle} onChange={set('venmo_handle')} /></label>
        <label className="field"><span>Zelle (phone or email)</span><input value={f.zelle_contact} onChange={set('zelle_contact')} /></label>
      </div>
      <label className="field"><span>Extra payment note (optional)</span><input placeholder="e.g. Cash or check also fine" value={f.payment_note} onChange={set('payment_note')} /></label>
      <label className="check"><input type="checkbox" checked={!!f.auto_invoice} onChange={set('auto_invoice')} /> On the 1st of each month, automatically create and email last month&rsquo;s invoices</label>
      <ErrorText error={act.error} />
      <button className="btn primary" disabled={act.busy} onClick={() => act.run(async () => { await put('/admin/settings', f); onSaved(); })}>Save</button>
    </section>
  );
}

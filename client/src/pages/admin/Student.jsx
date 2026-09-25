import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post } from '../../api.js';
import ReportsCard from '../../components/Reports.jsx';
import { DAYS_LONG, STATUS_LABEL, copy, fmtTime, fmtWhen, money, useLoad } from '../../util.js';
import SessionModal from '../../components/SessionModal.jsx';
import { ErrorText, Loading, Stat, StatusPill, useAction } from '../../components/ui.jsx';
import { AddSession } from './Calendar.jsx';

export default function Student() {
  const { id } = useParams();
  const { data, error, reload } = useLoad(() => get(`/admin/students/${id}`), [id]);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const { student: st, stats } = data;

  return (
    <div className="page">
      <div className="page-head">
        <h1>{st.name} {!st.active && <span className="tag">inactive</span>}</h1>
        <button className="btn primary" onClick={() => setAdding(true)}>+ Add session</button>
      </div>
      <div className="stats">
        <Stat label="Sessions done" value={stats.completed || 0} />
        <Stat label="Earned" value={money(stats.earned_cents)} sub={stats.unpaid_cents ? `${money(stats.unpaid_cents)} unpaid` : 'All paid'} />
        <Stat label="Family cancels" value={stats.client_cancels || 0} sub={`${stats.late_cancels || 0} late · ${stats.no_shows || 0} no-shows`} />
        <Stat label="You cancelled" value={stats.tutor_cancels || 0} />
      </div>

      <div className="two-col">
        <div>
          <NotesCard st={st} onSaved={reload} />
          <ReportsCard st={st} reports={data.reports} aiEnabled={data.ai_enabled} onChanged={reload} />
          <section className="card">
            <h2>Upcoming</h2>
            {data.upcoming.length === 0 && <p className="muted">Nothing scheduled.</p>}
            <ul className="list">
              {data.upcoming.map((s) => (
                <li key={s.id} className="list-row clickable" onClick={() => setOpen(s)}>{fmtWhen(s.start_at, s.end_at)}</li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h2>History</h2>
            <ul className="list">
              {data.sessions.map((s) => (
                <li key={s.id} className="list-row clickable col" onClick={() => setOpen(s)}>
                  <div><strong>{fmtWhen(s.start_at, s.end_at)}</strong> <StatusPill status={s.status}>{STATUS_LABEL[s.status]}</StatusPill>
                    {s.cancelled_by && <span className="small muted"> by {s.cancelled_by === 'client' ? 'family' : 'you'}{s.late_cancel ? ' · late' : ''}</span>}
                    {(s.status === 'completed' || s.charged) && !s.paid ? <span className="tag late">unpaid</span> : null}
                  </div>
                  {s.topics && <div className="small">Covered: {s.topics}</div>}
                  {s.notes && <div className="small muted">{s.notes}</div>}
                  {s.next_plan && <div className="small plan-inline">Next: {s.next_plan}</div>}
                </li>
              ))}
            </ul>
            {stats.unpaid_cents > 0 && (
              <button className="btn" onClick={async () => { await post('/admin/sessions/mark-paid', { student_id: st.id }); reload(); }}>
                Mark all paid ({money(stats.unpaid_cents)})
              </button>
            )}
          </section>
        </div>
        <div>
          <Schedule st={st} rules={data.rules} onChanged={reload} />
          <FamilyPortal st={st} onChanged={reload} />
          <Profile st={st} onSaved={reload} />
        </div>
      </div>
      {open && <SessionModal session={open} onClose={() => setOpen(null)} onChanged={reload} />}
      {adding && <AddSession studentId={st.id} defaultDate={new Date().toISOString().slice(0, 10)} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
    </div>
  );
}

function NotesCard({ st, onSaved }) {
  const [f, setF] = useState({ next_plan: st.next_plan, notes: st.notes });
  useEffect(() => setF({ next_plan: st.next_plan, notes: st.notes }), [st.next_plan, st.notes]);
  const { busy, error, run } = useAction();
  const dirty = f.next_plan !== st.next_plan || f.notes !== st.notes;
  return (
    <section className="card">
      <label className="field"><span className="h2like">Next time</span>
        <textarea rows={3} value={f.next_plan} onChange={(e) => setF({ ...f, next_plan: e.target.value })} placeholder="What to do at the next session. Updates when you log a session." />
      </label>
      <label className="field"><span className="h2like">Student notes</span>
        <textarea rows={5} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Strengths, weak spots, teacher, test dates, how they learn best…" />
      </label>
      <ErrorText error={error} />
      <button className="btn primary" disabled={!dirty || busy} onClick={() => run(async () => { await patch(`/admin/students/${st.id}`, f); onSaved(); })}>
        {dirty ? 'Save notes' : 'Saved'}
      </button>
    </section>
  );
}

function Schedule({ st, rules, onChanged }) {
  const [f, setF] = useState({ weekday: 1, start_time: '15:30', duration_min: 60 });
  const { busy, error, run } = useAction();
  return (
    <section className="card">
      <h2>Weekly schedule</h2>
      <ul className="list">
        {rules.filter((r) => r.active).map((r) => (
          <li key={r.id} className="list-row">
            <span>{DAYS_LONG[r.weekday]} {fmtTime(r.start_time)} – {fmtTime(addMin(r.start_time, r.duration_min))}</span>
            <button className="btn subtle danger" onClick={() => window.confirm(`Stop ${DAYS_LONG[r.weekday]} ${fmtTime(r.start_time)} sessions? Past sessions and logs are kept.`) && run(async () => { await del(`/admin/rules/${r.id}`); onChanged(); })}>Stop</button>
          </li>
        ))}
      </ul>
      {rules.filter((r) => r.active).length === 0 && <p className="muted">No weekly sessions.</p>}
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); run(async () => { await post(`/admin/students/${st.id}/rules`, f); onChanged(); }); }}>
        <select value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })} aria-label="Day">
          {DAYS_LONG.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
        <input type="time" value={f.start_time} onChange={(e) => setF({ ...f, start_time: e.target.value })} aria-label="Start time" />
        <input type="number" min={15} step={15} value={f.duration_min} onChange={(e) => setF({ ...f, duration_min: Number(e.target.value) })} aria-label="Minutes" style={{ width: 70 }} />
        <button className="btn" disabled={busy}>Add weekly</button>
      </form>
      <ErrorText error={error} />
    </section>
  );
}

const addMin = (t, m) => { const [h, mi] = t.split(':').map(Number); const x = h * 60 + mi + m; return `${String(Math.floor(x / 60) % 24).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

function FamilyPortal({ st, onChanged }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/family/${st.portal_token}`;
  return (
    <section className="card">
      <h2>Family page</h2>
      <p className="hint">Send this private link to the family. They can see their sessions, your open times (others show as &ldquo;Other student&rdquo; / &ldquo;Busy&rdquo;), and request moves or cancellations for you to approve.</p>
      <div className="actions">
        <button className="btn" onClick={async () => setCopied(await copy(url))}>{copied ? 'Copied!' : 'Copy family link'}</button>
        <a className="btn subtle" href={url} target="_blank" rel="noreferrer">Preview</a>
        <button className="btn subtle" onClick={async () => { if (window.confirm('Make a new link? The old one stops working.')) { await post(`/admin/students/${st.id}/rotate-link`); onChanged(); } }}>New link</button>
      </div>
    </section>
  );
}

function Profile({ st, onSaved }) {
  const [f, setF] = useState(st);
  useEffect(() => setF(st), [st]);
  const { busy, error, run } = useAction();
  const nav = useNavigate();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <section className="card">
      <h2>Profile</h2>
      <form className="form" onSubmit={(e) => { e.preventDefault(); run(async () => { await patch(`/admin/students/${st.id}`, { ...f, rate_cents: Math.round(Number(f.rate_dollars ?? st.rate_cents / 100) * 100) }); onSaved(); }); }}>
        <label className="field"><span>Name</span><input value={f.name} onChange={set('name')} required /></label>
        <label className="field"><span>Parent</span><input value={f.parent_name} onChange={set('parent_name')} /></label>
        <label className="field"><span>Email</span><input value={f.email} onChange={set('email')} /></label>
        <label className="field"><span>Phone</span><input value={f.phone} onChange={set('phone')} /></label>
        <div className="grid2">
          <label className="field"><span>Subject</span><input value={f.subject} onChange={set('subject')} /></label>
          <label className="field"><span>Grade</span><input value={f.grade} onChange={set('grade')} /></label>
        </div>
        <label className="field"><span>Rate per session ($)</span><input type="number" min={0} step="0.01" value={f.rate_dollars ?? st.rate_cents / 100} onChange={set('rate_dollars')} /></label>
        <label className="check"><input type="checkbox" checked={!!f.active} onChange={(e) => setF({ ...f, active: e.target.checked ? 1 : 0 })} /> Active (inactive students&rsquo; future sessions are removed)</label>
        <ErrorText error={error} />
        <div className="actions">
          <button type="button" className="btn subtle danger" onClick={() => window.confirm(`Delete ${st.name}? Only possible if nothing was logged.`) && run(async () => { await del(`/admin/students/${st.id}`); nav('/admin/students'); })}>Delete</button>
          <button className="btn primary" disabled={busy}>Save profile</button>
        </div>
      </form>
    </section>
  );
}

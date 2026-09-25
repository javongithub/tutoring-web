import { useState } from 'react';
import { get, post } from '../../api.js';
import { fmtDate, fmtRange, fmtWhen, money, useLoad } from '../../util.js';
import SessionModal from '../../components/SessionModal.jsx';
import { ErrorText, Loading, Stat, useAction } from '../../components/ui.jsx';

export default function Dashboard() {
  const { data, error, reload } = useLoad(() => get('/admin/dashboard'));
  const [open, setOpen] = useState(null);
  const act = useAction();
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const e = data.earnings;
  const requests = data.pending.length + data.changes.length;

  const decide = (c, approve) => act.run(async () => {
    let body = {};
    if (!approve) {
      const note = window.prompt('Note to the family (optional):', '');
      if (note === null) return;
      body = { note };
    }
    try {
      await post(`/admin/changes/${c.id}/${approve ? 'approve' : 'decline'}`, body);
    } catch (err) {
      if (err.status === 409 && window.confirm(`${err.message}\n\nApprove anyway?`)) {
        await post(`/admin/changes/${c.id}/approve`, { force: 1 });
      } else throw err;
    }
    reload();
  });

  return (
    <div className="page">
      <h1>Dashboard</h1>
      <div className="stats">
        <Stat label="Earned this week" value={money(e.week.cents)} sub={`${e.week.n} sessions · ${money(e.scheduled_week.cents)} scheduled`} />
        <Stat label="Earned this month" value={money(e.month.cents)} sub={`${e.month.n} sessions`} />
        <Stat label="Unpaid" value={money(e.unpaid.cents)} sub={`${e.unpaid.n} sessions`} />
        <Stat label="All time" value={money(e.all_time.cents)} sub={`${e.all_time.n} sessions`} />
      </div>

      <section className="card">
        <h2>Requests to approve {requests > 0 && <span className="badge">{requests}</span>}</h2>
        {requests === 0 && <p className="muted">Nothing waiting on you.</p>}
        <ul className="list">
          {data.pending.map((s) => (
            <li key={`b${s.id}`} className="list-row">
              <div>
                <span className="tag new">New booking</span> <strong>{s.student_name || s.requester_student}</strong>
                <span className="muted"> · {s.requester_name}</span>
                <div>{fmtWhen(s.start_at, s.end_at)}</div>
                {s.requester_message && <div className="muted small">“{s.requester_message}”</div>}
              </div>
              <div className="row-actions"><button className="btn primary" onClick={() => setOpen(s)}>Review</button></div>
            </li>
          ))}
          {data.changes.map((c) => (
            <li key={`c${c.id}`} className="list-row">
              <div>
                <span className={`tag ${c.kind}`}>{c.kind === 'cancel' ? 'Cancel request' : 'Move request'}</span>{' '}
                <strong>{c.student_name}</strong>
                <div>
                  {c.kind === 'cancel'
                    ? <>{fmtWhen(c.start_at, c.end_at)}{c.late ? <span className="tag late">late</span> : null}</>
                    : <>{fmtWhen(c.start_at, c.end_at)} → <strong>{fmtWhen(c.new_start_at, c.new_end_at)}</strong></>}
                </div>
                {c.reason && <div className="muted small">“{c.reason}”</div>}
              </div>
              <div className="row-actions">
                <button className="btn" disabled={act.busy} onClick={() => decide(c, false)}>Decline</button>
                <button className="btn primary" disabled={act.busy} onClick={() => decide(c, true)}>Approve</button>
              </div>
            </li>
          ))}
        </ul>
        <ErrorText error={act.error} />
      </section>

      {data.needs_log.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Needs logging <span className="badge">{data.needs_log.length}</span></h2>
            <button className="btn subtle" onClick={() => window.confirm('Mark all of these as done without notes?') && act.run(async () => { await post('/admin/sessions/complete-past'); reload(); })}>
              Mark all done
            </button>
          </div>
          <ul className="list">
            {data.needs_log.map((s) => (
              <li key={s.id} className="list-row clickable" onClick={() => setOpen(s)}>
                <div><strong>{s.student_name}</strong> <span className="muted">· {fmtWhen(s.start_at, s.end_at)}</span></div>
                <button className="btn">Log</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Coming up</h2>
        <ul className="list">
          {data.upcoming.map((s) => (
            <li key={s.id} className="list-row clickable" onClick={() => setOpen(s)}>
              <div>
                <strong>{s.student_name}</strong> <span className="muted">· {fmtDate(s.start_at)} · {fmtRange(s.start_at, s.end_at)}</span>
                {s.student_next_plan && <div className="small plan-inline">Plan: {s.student_next_plan}</div>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {open && <SessionModal session={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

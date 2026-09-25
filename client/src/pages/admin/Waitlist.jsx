import { get, patch } from '../../api.js';
import { DAYS, useLoad } from '../../util.js';
import { ErrorText, Loading, useAction } from '../../components/ui.jsx';

export default function Waitlist() {
  const { data, error, reload } = useLoad(() => get('/admin/waitlist'));
  const act = useAction();
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const active = data.filter((w) => w.status === 'active');
  const set = (w, status) => act.run(async () => { await patch(`/admin/waitlist/${w.id}`, { status }); reload(); });
  return (
    <div className="page">
      <h1>Waitlist</h1>
      <p className="hint">
        Families join from your booking page. When a time opens (a cancellation, a moved session, new availability), everyone whose days match is emailed automatically, once per opening.
      </p>
      <section className="card">
        <h2>Waiting <span className="badge">{active.length}</span></h2>
        {active.length === 0 && <p className="muted">Nobody waiting.</p>}
        <ul className="list">
          {active.map((w) => (
            <li key={w.id} className="list-row">
              <div>
                <strong>{w.student_name}</strong> <span className="muted">· {w.parent_name} · <a href={`mailto:${w.email}`}>{w.email}</a>{w.phone ? ` · ${w.phone}` : ''}</span>
                <div className="small">
                  {w.weekdays ? w.weekdays.split(',').map((d) => DAYS[Number(d)]).join(', ') : 'Any day'} · joined {w.created_at.slice(0, 10)}
                  {w.last_notified_at && <> · last emailed {w.last_notified_at.replace('T', ' ')}</>}
                </div>
                {w.note && <div className="small muted">“{w.note}”</div>}
              </div>
              <div className="row-actions">
                <button className="btn" onClick={() => set(w, 'booked')}>Booked</button>
                <button className="btn subtle danger" onClick={() => set(w, 'removed')}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
        <ErrorText error={act.error} />
      </section>
      {data.length > active.length && (
        <details className="card">
          <summary>Past entries ({data.length - active.length})</summary>
          <ul className="list">
            {data.filter((w) => w.status !== 'active').map((w) => (
              <li key={w.id} className="list-row">
                <span>{w.student_name} <span className="muted">· {w.email} · {w.status}</span></span>
                <button className="btn subtle" onClick={() => set(w, 'active')}>Restore</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

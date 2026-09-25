import { Link } from 'react-router-dom';
import { get } from '../../api.ts';
import { fmtWhen, money, useLoad } from '../../util.ts';
import { ErrorText, Loading } from '../../components/ui.tsx';

export default function Cancellations() {
  const { data, error } = useLoad(() => get('/admin/cancellations'));
  const { data: changes } = useLoad(() => get('/admin/changes'));
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="page">
      <h1>Cancellations</h1>
      <p className="muted">Last 90 days through the next 90.</p>

      <section className="card">
        <h2>By student</h2>
        {data.by_student.length === 0 ? <p className="muted">No cancellations. 🎉</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Student</th><th className="num">Family cancels</th><th className="num">Late</th><th className="num">No-shows</th><th className="num">Cancel rate</th><th className="num">You cancelled</th><th className="num">Lost $</th></tr></thead>
              <tbody>
                {data.by_student.map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/admin/students/${r.id}`}>{r.name}</Link></td>
                    <td className="num">{r.client_cancels}</td>
                    <td className="num">{r.late_cancels || ''}</td>
                    <td className="num">{r.no_shows || ''}</td>
                    <td className="num">{r.total ? `${Math.round(((r.client_cancels + r.no_shows) / r.total) * 100)}%` : ''}</td>
                    <td className="num">{r.tutor_cancels || ''}</td>
                    <td className="num">{money(r.lost_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>All cancellations</h2>
        <ul className="list">
          {data.rows.map((s) => (
            <li key={s.id} className="list-row col">
              <div>
                <strong>{s.student_name || s.requester_student}</strong> · {fmtWhen(s.start_at, s.end_at)}{' '}
                <span className={`tag ${s.status === 'cancelled' && s.cancelled_by === 'client' ? 'cancel' : ''}`}>
                  {s.status === 'declined' ? 'You declined request' : s.status === 'no_show' ? 'No-show' : s.cancelled_by === 'client' ? 'Family cancelled' : 'You cancelled'}
                </span>
                {s.late_cancel ? <span className="tag late">late</span> : null}
                {s.charged ? <span className="tag">charged</span> : null}
              </div>
              {s.cancel_reason && <div className="small muted">“{s.cancel_reason}”</div>}
            </li>
          ))}
        </ul>
      </section>

      {changes && changes.length > 0 && (
        <section className="card">
          <h2>Change requests from families</h2>
          <ul className="list">
            {changes.map((c) => (
              <li key={c.id} className="list-row col">
                <div>
                  <strong>{c.student_name}</strong> asked to {c.kind === 'cancel' ? 'cancel' : 'move'} {fmtWhen(c.start_at)}
                  {c.kind === 'reschedule' && <> → {fmtWhen(c.new_start_at)}</>}{' '}
                  <span className={`tag ${c.status}`}>{c.status}</span>
                </div>
                <div className="small muted">Asked {c.requested_at.replace('T', ' ')}{c.reason ? ` · “${c.reason}”` : ''}{c.tutor_note ? ` · your note: “${c.tutor_note}”` : ''}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

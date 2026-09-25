import { useState } from 'react';
import type { SessionView } from '../../../../server/types.ts';
import type { StudentListItem, TutoringLog } from '../../../../server/api-types.ts';
import { get } from '../../api.ts';
import { durationMin, fmtWhen, money, useLoad, type FieldEvent } from '../../util.ts';
import SessionModal from '../../components/SessionModal.tsx';
import { ErrorText, Loading, Stat } from '../../components/ui.tsx';

export default function Log() {
  const [q, setQ] = useState({ from: '', to: '', student_id: '', paid: '' });
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  const { data, error, reload } = useLoad(() => get<TutoringLog>(`/admin/log?${qs}`), [qs]);
  const { data: students } = useLoad(() => get<StudentListItem[]>('/admin/students'));
  const [open, setOpen] = useState<SessionView | null>(null);
  const set = (k: keyof typeof q) => (e: FieldEvent) => setQ({ ...q, [k]: e.target.value });

  return (
    <div className="page">
      <div className="page-head">
        <h1>Tutoring log</h1>
        <a className="btn" href={`/api/admin/log.csv?${qs}`}>Export CSV</a>
      </div>
      <div className="filters">
        <label>From <input type="date" value={q.from} onChange={set('from')} /></label>
        <label>To <input type="date" value={q.to} onChange={set('to')} /></label>
        <select value={q.student_id} onChange={set('student_id')} aria-label="Student">
          <option value="">All students</option>
          {(students || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={q.paid} onChange={set('paid')} aria-label="Paid">
          <option value="">Paid & unpaid</option><option value="0">Unpaid only</option><option value="1">Paid only</option>
        </select>
      </div>
      <ErrorText error={error} />
      {!data ? <Loading /> : (
        <>
          <div className="stats">
            <Stat label="Sessions" value={data.totals.sessions} sub={`${data.totals.hours.toFixed(1)} hours`} />
            <Stat label="Earned" value={money(data.totals.earned_cents)} />
            <Stat label="Unpaid" value={money(data.totals.unpaid_cents)} />
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>Student</th><th>Covered / notes</th><th>Next time</th><th className="num">$</th></tr></thead>
              <tbody>
                {data.rows.map((s) => (
                  <tr key={s.id} className="clickable" onClick={() => setOpen(s)}>
                    <td className="nowrap">{fmtWhen(s.start_at)}<div className="small muted">{durationMin(s.start_at, s.end_at)} min{s.status !== 'completed' ? ` · ${s.status === 'no_show' ? 'no-show' : 'late cancel'}` : ''}</div></td>
                    <td>{s.student_name}</td>
                    <td>{s.topics}{s.notes && <div className="small muted">{s.notes}</div>}</td>
                    <td className="small">{s.next_plan}</td>
                    <td className="num nowrap">{(s.status === 'completed' || s.charged) ? money(s.rate_cents) : '—'}{(s.status === 'completed' || s.charged) && !s.paid ? <div className="tag late">unpaid</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.rows.length === 0 && <p className="muted center">No logged sessions yet. Log them from the dashboard or calendar.</p>}
          </div>
        </>
      )}
      {open && <SessionModal session={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

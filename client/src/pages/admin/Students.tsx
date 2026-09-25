import { useState } from 'react';
import type { StudentRow } from '../../../../server/types.ts';
import type { StudentListItem } from '../../../../server/api-types.ts';
import { Link, useNavigate } from 'react-router-dom';
import { get, post } from '../../api.ts';
import { fmtWhen, money, useLoad, type FieldEvent } from '../../util.ts';
import { ErrorText, Loading, Modal, useAction } from '../../components/ui.tsx';

export default function Students() {
  const { data, error } = useLoad(() => get<StudentListItem[]>('/admin/students'));
  const [adding, setAdding] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const rows = data.filter((s) => showInactive || s.active);
  return (
    <div className="page">
      <div className="page-head">
        <h1>Students</h1>
        <button className="btn primary" onClick={() => setAdding(true)}>+ Add student</button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Student</th><th>Parent</th><th>Next session</th><th className="num">Done</th><th className="num">Cancels</th><th className="num">Unpaid</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className={s.active ? '' : 'muted'}>
                <td><Link to={`/admin/students/${s.id}`}><strong>{s.name}</strong></Link>{s.subject && <div className="small muted">{s.subject}</div>}</td>
                <td>{s.parent_name}</td>
                <td>{s.next_session ? fmtWhen(s.next_session) : <span className="muted">—</span>}</td>
                <td className="num">{s.completed}</td>
                <td className="num">{s.client_cancels || ''}</td>
                <td className="num">{s.unpaid_cents ? money(s.unpaid_cents) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
      {adding && <AddStudent onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddStudent({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', parent_name: '', email: '', phone: '', subject: '', grade: '' });
  const { busy, error, run } = useAction();
  const nav = useNavigate();
  const set = (k: keyof typeof f) => (e: FieldEvent) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Add student" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); run(async () => { const s = await post<StudentRow>('/admin/students', f); nav(`/admin/students/${s.id}`); }); }}>
        <div className="grid2">
          <label className="field"><span>Student name</span><input required value={f.name} onChange={set('name')} autoFocus /></label>
          <label className="field"><span>Parent</span><input value={f.parent_name} onChange={set('parent_name')} /></label>
          <label className="field"><span>Email</span><input type="email" value={f.email} onChange={set('email')} /></label>
          <label className="field"><span>Phone</span><input value={f.phone} onChange={set('phone')} /></label>
          <label className="field"><span>Subject / class</span><input value={f.subject} onChange={set('subject')} /></label>
          <label className="field"><span>Grade</span><input value={f.grade} onChange={set('grade')} /></label>
        </div>
        <ErrorText error={error} />
        <div className="actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>Add</button></div>
      </form>
    </Modal>
  );
}

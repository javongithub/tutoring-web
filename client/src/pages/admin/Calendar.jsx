import { useState } from 'react';
import { get, post } from '../../api.js';
import { addDays, useLoad, weekStart, weekday } from '../../util.js';
import WeekGrid, { Legend, WeekNav } from '../../components/WeekGrid.jsx';
import SessionModal from '../../components/SessionModal.jsx';
import { ErrorText, Loading, Modal, useAction } from '../../components/ui.jsx';

const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export default function Calendar() {
  const today = localToday();
  const [start, setStart] = useState(weekStart(today));
  const { data, error, reload } = useLoad(() => get(`/admin/sessions?from=${start}&to=${addDays(start, 7)}`), [start]);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  if (error) return <ErrorText error={error} />;

  const items = [];
  if (data) {
    const appStarts = new Set(data.sessions.filter((s) => s.student_id).map((s) => s.start_at));
    for (const s of data.sessions) {
      if (s.status === 'declined') continue;
      items.push({
        start_at: s.start_at, end_at: s.end_at,
        title: s.student_name || `${s.requester_student} (request)`,
        sub: s.status === 'confirmed' ? '' : { pending: 'Needs approval', completed: 'Done', cancelled: `Cancelled${s.cancelled_by === 'client' ? ' by family' : ''}`, no_show: 'No-show' }[s.status],
        kind: { pending: 'pending', confirmed: 'own', completed: 'done', cancelled: 'cancelled', no_show: 'cancelled' }[s.status],
        onClick: () => setOpen(s),
      });
    }
    for (const e of data.calendar) {
      if (e.from_app || (e.is_tutoring && appStarts.has(e.start_at))) continue;
      items.push({ start_at: e.start_at, end_at: e.end_at, title: e.summary, sub: 'Google Calendar', kind: e.is_tutoring ? 'other' : 'busy' });
    }
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      for (const b of data.blocks.filter((x) => x.weekday === weekday(d))) {
        items.push({ start_at: `${d}T${b.start_time}`, end_at: `${d}T${b.end_time}`, title: b.label, kind: 'busy' });
      }
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Calendar</h1>
        <button className="btn primary" onClick={() => setAdding(true)}>+ Add session</button>
      </div>
      <WeekNav start={start} onChange={setStart} />
      {!data ? <Loading /> : <WeekGrid start={start} today={today} items={items} minHour={14} />}
      <Legend items={[['own', 'Scheduled'], ['pending', 'Needs approval'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['busy', 'Busy (private)'], ['other', 'Tutoring on Google Cal, not in app']]} />
      {open && <SessionModal session={open} onClose={() => setOpen(null)} onChanged={reload} />}
      {adding && <AddSession onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} defaultDate={start > today ? start : today} />}
    </div>
  );
}

export function AddSession({ onClose, onDone, defaultDate, studentId }) {
  const { data: students } = useLoad(() => get('/admin/students'));
  const [f, setF] = useState({ student_id: studentId || '', start_at: `${defaultDate}T15:30`, duration_min: 60, repeat_weekly: false });
  const { busy, error, run } = useAction();
  return (
    <Modal title="Add session" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); run(async () => { await post('/admin/sessions', f); onDone(); }); }}>
        {!studentId && (
          <label className="field"><span>Student</span>
            <select required value={f.student_id} onChange={(e) => setF({ ...f, student_id: e.target.value })}>
              <option value="">Choose…</option>
              {(students || []).filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <div className="grid2">
          <label className="field"><span>Start</span><input type="datetime-local" required value={f.start_at} onChange={(e) => setF({ ...f, start_at: e.target.value })} /></label>
          <label className="field"><span>Minutes</span><input type="number" min={15} max={480} step={15} value={f.duration_min} onChange={(e) => setF({ ...f, duration_min: Number(e.target.value) })} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.repeat_weekly} onChange={(e) => setF({ ...f, repeat_weekly: e.target.checked })} /> Repeat every week</label>
        <ErrorText error={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>Add</button>
        </div>
      </form>
    </Modal>
  );
}

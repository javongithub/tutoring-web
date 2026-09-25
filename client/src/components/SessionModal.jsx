import { useState } from 'react';
import { Link } from 'react-router-dom';
import { del, patch, post } from '../api.js';
import { STATUS_LABEL, copy, durationMin, fmtDate, fmtRange, money } from '../util.js';
import { ErrorText, Modal, StatusPill, useAction } from './ui.jsx';

// Everything you can do to one session: log it, cancel, no-show, move, mark paid,
// approve/decline a website request.
export default function SessionModal({ session: s, onClose, onChanged }) {
  const [mode, setMode] = useState(s.status === 'confirmed' && s.end_at <= nowish() ? 'log' : 'view');
  const { busy, error, run } = useAction();
  const done = (fn) => run(async () => { await fn(); onChanged(); onClose(); });
  const who = s.student_name || s.requester_student || 'New student';

  return (
    <Modal title={who} onClose={onClose}>
      <p className="modal-when">
        {fmtDate(s.start_at, { long: true })} · {fmtRange(s.start_at, s.end_at)}{' '}
        <StatusPill status={s.status}>{STATUS_LABEL[s.status]}</StatusPill>
        {s.paid ? <StatusPill status="paid">Paid</StatusPill> : null}
      </p>
      {s.student_id && <p><Link to={`/admin/students/${s.student_id}`} onClick={onClose}>Open student profile →</Link></p>}

      {s.status === 'pending' && <PendingPanel s={s} done={done} busy={busy} />}

      {mode === 'view' && s.status !== 'pending' && (
        <>
          {s.student_next_plan && s.status === 'confirmed' && (
            <div className="plan"><strong>Plan for this session</strong><p>{s.student_next_plan}</p></div>
          )}
          {s.status === 'completed' && <LogSummary s={s} />}
          {s.status === 'cancelled' && (
            <p className="notice warn">
              Cancelled by {s.cancelled_by === 'client' ? 'the family' : 'you'}{s.late_cancel ? ' (late)' : ''}
              {s.cancel_reason ? ` — “${s.cancel_reason}”` : ''}
            </p>
          )}
          <div className="actions wrap">
            {['confirmed', 'completed', 'no_show'].includes(s.status) && <button className="btn primary" onClick={() => setMode('log')}>{s.status === 'completed' ? 'Edit log' : 'Log session'}</button>}
            {s.status === 'confirmed' && <button className="btn" onClick={() => setMode('move')}>Move</button>}
            {s.status === 'confirmed' && <button className="btn" onClick={() => setMode('cancel')}>Cancel…</button>}
            {s.status === 'confirmed' && s.start_at <= nowish() && (
              <button className="btn" onClick={() => done(() => post(`/admin/sessions/${s.id}/no-show`, { charged: 1 }))}>No-show</button>
            )}
            {(s.status === 'completed' || s.charged) ? (
              <button className="btn" onClick={() => done(() => post('/admin/sessions/mark-paid', { ids: [s.id], paid: s.paid ? 0 : 1 }))}>
                {s.paid ? 'Mark unpaid' : `Mark paid (${money(s.rate_cents)})`}
              </button>
            ) : null}
            {['cancelled', 'no_show', 'completed', 'declined'].includes(s.status) && (
              <button className="btn subtle" onClick={() => done(() => post(`/admin/sessions/${s.id}/reopen`))}>Undo → scheduled</button>
            )}
            {!s.recurring_id && s.status !== 'completed' && (
              <button className="btn subtle danger" onClick={() => window.confirm('Delete this session permanently?') && done(() => del(`/admin/sessions/${s.id}`))}>Delete</button>
            )}
          </div>
        </>
      )}
      {mode === 'log' && <LogForm s={s} onSave={(body) => done(() => post(`/admin/sessions/${s.id}/complete`, body))} onBack={() => setMode('view')} busy={busy} />}
      {mode === 'cancel' && <CancelForm s={s} onSave={(body) => done(() => post(`/admin/sessions/${s.id}/cancel`, body))} onBack={() => setMode('view')} busy={busy} />}
      {mode === 'move' && <MoveForm s={s} onSave={(body) => done(() => patch(`/admin/sessions/${s.id}`, body))} onBack={() => setMode('view')} busy={busy} />}
      <ErrorText error={error} />
      {s.token && s.status !== 'declined' && <FamilyLink token={s.token} />}
    </Modal>
  );
}

const nowish = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function PendingPanel({ s, done, busy }) {
  const [weekly, setWeekly] = useState(false);
  return (
    <div className="request">
      <p className="notice pending">Booking request from the website</p>
      <dl className="kv">
        <dt>Parent</dt><dd>{s.requester_name || s.parent_name}</dd>
        {s.requester_email && <><dt>Email</dt><dd><a href={`mailto:${s.requester_email}`}>{s.requester_email}</a></dd></>}
        {s.requester_phone && <><dt>Phone</dt><dd><a href={`tel:${s.requester_phone}`}>{s.requester_phone}</a></dd></>}
        {s.requester_message && <><dt>Message</dt><dd>{s.requester_message}</dd></>}
      </dl>
      <label className="check"><input type="checkbox" checked={weekly} onChange={(e) => setWeekly(e.target.checked)} /> Make this a weekly session</label>
      <div className="actions">
        <button className="btn danger" disabled={busy} onClick={() => { const reason = window.prompt('Reason (shown to the family, optional):', ''); if (reason !== null) done(() => post(`/admin/sessions/${s.id}/decline`, { reason })); }}>Decline</button>
        <button className="btn primary" disabled={busy} onClick={() => done(() => post(`/admin/sessions/${s.id}/confirm`, { repeat_weekly: weekly }))}>Confirm</button>
      </div>
    </div>
  );
}

function LogSummary({ s }) {
  return (
    <dl className="kv">
      <dt>Covered</dt><dd>{s.topics || <span className="muted">—</span>}</dd>
      <dt>Notes</dt><dd>{s.notes || <span className="muted">—</span>}</dd>
      <dt>Next time</dt><dd>{s.next_plan || <span className="muted">—</span>}</dd>
    </dl>
  );
}

function LogForm({ s, onSave, onBack, busy }) {
  const [f, setF] = useState({ topics: s.topics, notes: s.notes, next_plan: s.next_plan });
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); onSave(f); }}>
      {s.student_next_plan && s.status !== 'completed' && (
        <div className="plan"><strong>Planned for today</strong><p>{s.student_next_plan}</p></div>
      )}
      <label className="field"><span>What we covered</span><textarea rows={2} value={f.topics} onChange={(e) => setF({ ...f, topics: e.target.value })} autoFocus /></label>
      <label className="field"><span>Notes (how it went, struggles, homework)</span><textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
      <label className="field"><span>What to do next time</span><textarea rows={2} value={f.next_plan} onChange={(e) => setF({ ...f, next_plan: e.target.value })} /></label>
      <div className="actions">
        <button type="button" className="btn" onClick={onBack}>Back</button>
        <button className="btn primary" disabled={busy}>Save · mark done ({money(s.rate_cents)})</button>
      </div>
    </form>
  );
}

function CancelForm({ s, onSave, onBack, busy }) {
  const [by, setBy] = useState('client');
  const [reason, setReason] = useState('');
  const [charged, setCharged] = useState(false);
  const [notify, setNotify] = useState(true);
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); onSave({ by, reason, charged: by === 'client' ? charged : false, notify: by === 'tutor' && notify }); }}>
      <div className="segmented">
        <button type="button" className={by === 'client' ? 'on' : ''} onClick={() => setBy('client')}>Family cancelled</button>
        <button type="button" className={by === 'tutor' ? 'on' : ''} onClick={() => setBy('tutor')}>I cancelled</button>
      </div>
      <label className="field"><span>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. sick, family trip" /></label>
      {by === 'client' && <label className="check"><input type="checkbox" checked={charged} onChange={(e) => setCharged(e.target.checked)} /> Still charge for it ({money(s.rate_cents)})</label>}
      {by === 'tutor' && <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email the family (if they have an email on file)</label>}
      {s.recurring_id && <p className="hint">Only this week is cancelled. The weekly schedule continues.</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={onBack}>Back</button>
        <button className="btn danger" disabled={busy}>Cancel session</button>
      </div>
    </form>
  );
}

function MoveForm({ s, onSave, onBack, busy }) {
  const [start, setStart] = useState(s.start_at);
  const [dur, setDur] = useState(durationMin(s.start_at, s.end_at));
  const [notify, setNotify] = useState(true);
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); onSave({ start_at: start, duration_min: Number(dur), notify }); }}>
      <div className="grid2">
        <label className="field"><span>New start</span><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
        <label className="field"><span>Minutes</span><input type="number" min={15} max={480} step={15} value={dur} onChange={(e) => setDur(e.target.value)} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email the family about the new time</label>
      {s.recurring_id && <p className="hint">Moves only this week. Edit the weekly schedule on the student&rsquo;s page to change every week.</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={onBack}>Back</button>
        <button className="btn primary" disabled={busy}>Move</button>
      </div>
    </form>
  );
}

function FamilyLink({ token }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/booking/${token}`;
  return (
    <p className="hint">
      Family link for this session:{' '}
      <button className="linkish" onClick={async () => { setCopied(await copy(url)); }}>{copied ? 'Copied!' : 'Copy link'}</button>
    </p>
  );
}

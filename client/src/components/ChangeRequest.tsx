import { useState } from 'react';
import { post } from '../api.ts';
import { fmtWhen } from '../util.ts';
import PublicWeek from './PublicWeek.tsx';
import { ErrorText, Modal, useAction } from './ui.tsx';

// Family asks to cancel or move a session. Nothing changes until the tutor approves.
export default function ChangeRequest({ session, family, onClose, onDone }) {
  const [kind, setKind] = useState('reschedule');
  const [slot, setSlot] = useState(null);
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const late = !!session.late_window;
  const { busy, error, run } = useAction();

  const submit = () => run(async () => {
    await post(`/public/booking/${session.token}/change`, { kind, reason, new_start_at: slot?.start_at, acknowledge_policy: ack });
    onDone();
  });

  return (
    <Modal title="Change this session" onClose={onClose} wide={kind === 'reschedule'}>
      <p className="muted">{session.student} · {fmtWhen(session.start_at, session.end_at)}</p>
      {late && (
        <div className="policy" role="alert">
          <strong>⚠️ Less than 24 hours&rsquo; notice</strong>
          <p>{session.policy}</p>
          <label className="check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            I understand the 24-hour cancellation &amp; reschedule policy.
          </label>
        </div>
      )}
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={kind === 'reschedule'} className={kind === 'reschedule' ? 'on' : ''} onClick={() => setKind('reschedule')}>Move to another time</button>
        <button role="tab" aria-selected={kind === 'cancel'} className={kind === 'cancel' ? 'on' : ''} onClick={() => setKind('cancel')}>Cancel</button>
      </div>
      {kind === 'reschedule' && (
        <>
          <p className="hint">Pick an open time. It&rsquo;s held for you while your tutor reviews the request.</p>
          <PublicWeek family={family} onSlot={setSlot} selected={slot?.start_at} />
          {slot && <p><strong>New time:</strong> {fmtWhen(slot.start_at, slot.end_at)}</p>}
        </>
      )}
      <label className="field">
        <span>Reason (optional)</span>
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      </label>
      <p className="hint">Your current session stays booked until your tutor approves this request.</p>
      <ErrorText error={error} />
      <div className="actions">
        <button className="btn" onClick={onClose}>Back</button>
        <button className="btn primary" disabled={busy || (kind === 'reschedule' && !slot) || (late && !ack)} onClick={submit}>
          {kind === 'cancel' ? 'Ask to cancel' : 'Ask to move'}
        </button>
      </div>
    </Modal>
  );
}

export function ChangeStatus({ s }) {
  if (s.change_request) {
    const c = s.change_request;
    return (
      <p className="notice pending">
        Waiting for approval: {c.kind === 'cancel' ? 'cancel this session' : `move to ${fmtWhen(c.new_start_at, c.new_end_at)}`}
      </p>
    );
  }
  if (s.last_decision) {
    const d = s.last_decision;
    const what = d.kind === 'cancel' ? 'cancel request' : 'move request';
    return (
      <p className={`notice ${d.status === 'approved' ? 'ok' : 'warn'}`}>
        Your {what} was {d.status}.{d.tutor_note ? ` Note: “${d.tutor_note}”` : ''}
      </p>
    );
  }
  return null;
}

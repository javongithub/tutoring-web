import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post } from '../../api.js';
import { STATUS_LABEL, fmtWhen, money, useLoad } from '../../util.js';
import PublicWeek from '../../components/PublicWeek.jsx';
import ChangeRequest, { ChangeStatus } from '../../components/ChangeRequest.jsx';
import { ErrorText, Loading, Modal, StatusPill, useAction } from '../../components/ui.jsx';

export default function Family() {
  const { token } = useParams();
  const { data, error, reload } = useLoad(() => get(`/public/family/${token}`), [token]);
  const [changing, setChanging] = useState(null);
  const [booking, setBooking] = useState(null);
  const [gridKey, setGridKey] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const act = useAction();
  const refresh = () => { reload(); setGridKey((k) => k + 1); };

  if (error) return <div className="public"><ErrorText error={error} /></div>;
  if (!data) return <div className="public"><Loading /></div>;

  const book = (message) => act.run(async () => {
    await post('/public/requests', { start_at: booking.start_at, family: token, message });
    setBooking(null);
    refresh();
  });

  return (
    <div className="public">
      <header className="hero">
        <h1>{data.student}&rsquo;s sessions</h1>
        <p>Need to move or cancel? Please send a request at least <strong>{data.cancel_notice_hours} hours before</strong> the session. Your tutor approves every change. Requests within {data.cancel_notice_hours} hours count as late.</p>
      </header>

      <section className="card">
        <h2>Upcoming</h2>
        {data.upcoming.length === 0 && <p className="muted">Nothing scheduled.</p>}
        <ul className="list">
          {(showAll ? data.upcoming : data.upcoming.slice(0, 6)).map((s) => (
            <li key={s.token} className="list-row">
              <div>
                <strong>{fmtWhen(s.start_at, s.end_at)}</strong>{' '}
                <StatusPill status={s.status}>{STATUS_LABEL[s.status]}</StatusPill>
                <ChangeStatus s={s} />
                {s.late_window && !s.change_request && <p className="small warn-text">Starts within 24 hours: late changes need your tutor&rsquo;s OK.</p>}
              </div>
              <div className="row-actions">
                {s.can_request_change && <button className="btn" onClick={() => setChanging(s)}>Move / cancel</button>}
                {s.change_request && (
                  <button className="btn subtle" onClick={() => act.run(async () => { await post(`/public/booking/${s.token}/change/withdraw`); refresh(); })}>
                    Withdraw request
                  </button>
                )}
                {s.can_withdraw && (
                  <button className="btn subtle" onClick={() => act.run(async () => { await post(`/public/booking/${s.token}/withdraw`); refresh(); })}>
                    Withdraw
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {data.upcoming.length > 6 && (
          <button className="btn subtle" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer' : `Show all ${data.upcoming.length}`}
          </button>
        )}
        {data.cancelled.length > 0 && (
          <details><summary className="muted">Cancelled ({data.cancelled.length})</summary>
            <ul className="list">{data.cancelled.map((s) => <li key={s.token} className="list-row muted">{fmtWhen(s.start_at, s.end_at)}</li>)}</ul>
          </details>
        )}
        <ErrorText error={act.error} />
      </section>

      {data.reports.length > 0 && (
        <section className="card">
          <h2>Progress reports</h2>
          <ul className="list">
            {data.reports.map((r) => (
              <li key={r.token} className="list-row">
                <span>{r.period_from} → {r.period_to}</span>
                <Link className="btn subtle" to={`/report/${r.token}`}>Read</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.invoices.length > 0 && (
        <section className="card">
          <h2>Invoices</h2>
          <ul className="list">
            {data.invoices.map((i) => (
              <li key={i.token} className="list-row">
                <span>{i.period_label} · <strong>{money(i.amount_cents)}</strong> <StatusPill status={i.status === 'paid' ? 'paid' : 'pending'}>{i.status === 'paid' ? 'Paid' : 'Due'}</StatusPill></span>
                <Link className="btn subtle" to={`/invoice/${i.token}`}>View</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Schedule</h2>
        <p className="hint">Tap an open time to request an extra session.</p>
        <PublicWeek key={gridKey} family={token} onSlot={setBooking} />
      </section>

      {changing && (
        <ChangeRequest session={changing} family={token} onClose={() => setChanging(null)} onDone={() => { setChanging(null); refresh(); }} />
      )}
      {booking && <BookExtra slot={booking} onClose={() => setBooking(null)} onBook={book} busy={act.busy} error={act.error} />}
    </div>
  );
}

function BookExtra({ slot, onClose, onBook, busy, error }) {
  const [msg, setMsg] = useState('');
  return (
    <Modal title="Request an extra session" onClose={onClose}>
      <p><strong>{fmtWhen(slot.start_at, slot.end_at)}</strong></p>
      <label className="field"><span>Note (optional)</span><textarea rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="e.g. Test on Friday" /></label>
      <ErrorText error={error} />
      <div className="actions">
        <button className="btn" onClick={onClose}>Back</button>
        <button className="btn primary" onClick={() => onBook(msg)} disabled={busy}>Send request</button>
      </div>
    </Modal>
  );
}

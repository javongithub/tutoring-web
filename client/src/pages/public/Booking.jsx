import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post } from '../../api.js';
import { STATUS_LABEL, fmtWhen, useLoad } from '../../util.js';
import ChangeRequest, { ChangeStatus } from '../../components/ChangeRequest.jsx';
import { ErrorText, Loading, StatusPill, useAction } from '../../components/ui.jsx';

export default function Booking() {
  const { token } = useParams();
  const { data: s, error, reload } = useLoad(() => get(`/public/booking/${token}`), [token]);
  const [changing, setChanging] = useState(false);
  const act = useAction();
  if (error) return <div className="public"><ErrorText error={error} /></div>;
  if (!s) return <div className="public"><Loading /></div>;

  const withdraw = () => act.run(async () => {
    if (!window.confirm('Withdraw this request?')) return;
    await post(`/public/booking/${token}/withdraw`);
    reload();
  });

  return (
    <div className="public narrow">
      <section className="card">
        <StatusPill status={s.status}>{STATUS_LABEL[s.status]}</StatusPill>
        <h1>{s.student}</h1>
        <p className="big-when">{fmtWhen(s.start_at, s.end_at)}</p>
        {s.status === 'pending' && (
          <p>Thanks! Your request was sent. You&rsquo;ll get a confirmation once it&rsquo;s approved. <strong>Bookmark this page</strong> to check on it.</p>
        )}
        {s.status === 'declined' && <p>Sorry, this time couldn&rsquo;t be confirmed. <Link to="/">Pick another time</Link>.</p>}
        <ChangeStatus s={s} />
        {s.family_token && (
          <p className="notice ok">
            You&rsquo;re booked. Your family page shows every upcoming session and lets you ask for changes:{' '}
            <Link to={`/family/${s.family_token}`}>open your family page</Link> (bookmark it).
          </p>
        )}
        <ErrorText error={act.error} />
        <div className="actions">
          {s.can_withdraw && <button className="btn danger" onClick={withdraw} disabled={act.busy}>Withdraw request</button>}
          {s.can_request_change && <button className="btn" onClick={() => setChanging(true)}>Ask to move or cancel</button>}
          {s.change_request && (
            <button className="btn" onClick={() => act.run(async () => { await post(`/public/booking/${token}/change/withdraw`); reload(); })}>
              Withdraw change request
            </button>
          )}
        </div>
      </section>
      {changing && (
        <ChangeRequest session={s} family={s.family_token} onClose={() => setChanging(false)} onDone={() => { setChanging(false); reload(); }} />
      )}
    </div>
  );
}

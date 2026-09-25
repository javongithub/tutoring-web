import { useParams } from 'react-router-dom';
import { get, post } from '../../api.ts';
import { DAYS, useLoad } from '../../util.ts';
import { ErrorText, Loading, useAction } from '../../components/ui.tsx';

export default function WaitlistEntry() {
  const { token } = useParams();
  const { data, error, reload } = useLoad(() => get(`/public/waitlist/${token}`), [token]);
  const act = useAction();
  if (error) return <div className="public narrow"><ErrorText error={error} /></div>;
  if (!data) return <div className="public narrow"><Loading /></div>;
  const days = data.weekdays ? data.weekdays.split(',').map((d) => DAYS[Number(d)]).join(', ') : 'any day';
  return (
    <div className="public narrow">
      <section className="card">
        <h1>Waitlist: {data.student_name}</h1>
        {data.status === 'active' && (
          <>
            <p>You&rsquo;re on the waitlist ({days}). We&rsquo;ll email you when a time opens.</p>
            <ErrorText error={act.error} />
            <button className="btn danger" disabled={act.busy} onClick={() => act.run(async () => { await post(`/public/waitlist/${token}/leave`); reload(); })}>
              Leave the waitlist
            </button>
          </>
        )}
        {data.status === 'booked' && <p>You booked a session, so you&rsquo;re off the waitlist. See you soon!</p>}
        {data.status === 'removed' && <p>You&rsquo;re no longer on the waitlist. <a href="/#waitlist">Join again</a> any time.</p>}
      </section>
    </div>
  );
}

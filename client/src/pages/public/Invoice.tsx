import { Link, useParams } from 'react-router-dom';
import { get } from '../../api.ts';
import { copy, fmtWhen, money, useLoad } from '../../util.ts';
import { ErrorText, Loading, StatusPill } from '../../components/ui.tsx';
import { useState } from 'react';

export default function Invoice() {
  const { token } = useParams();
  const { data: inv, error } = useLoad(() => get(`/public/invoice/${token}`), [token]);
  const [copied, setCopied] = useState(false);
  if (error) return <div className="public narrow"><ErrorText error={error} /></div>;
  if (!inv) return <div className="public narrow"><Loading /></div>;
  return (
    <div className="public narrow">
      <section className="card invoice">
        <p className="muted">{inv.tutor_name}</p>
        <h1>Invoice: {inv.student}, {inv.period_label}</h1>
        <StatusPill status={inv.status === 'paid' ? 'paid' : 'pending'}>{inv.status === 'paid' ? `Paid ${inv.paid_at?.slice(0, 10) || ''}` : 'Due'}</StatusPill>
        <table className="table">
          <tbody>
            {inv.items.map((s) => (
              <tr key={s.start_at}>
                <td>{fmtWhen(s.start_at, s.end_at)}{s.status !== 'completed' && <span className="small muted"> ({s.status === 'no_show' ? 'no-show' : 'late cancellation'})</span>}</td>
                <td className="num">{money(s.rate_cents)}</td>
              </tr>
            ))}
            <tr className="total"><td>Total</td><td className="num">{money(inv.amount_cents)}</td></tr>
          </tbody>
        </table>
        {inv.status !== 'paid' && (
          <div className="pay">
            <h2>How to pay</h2>
            {inv.pay.venmo && (
              <p>
                <a className="btn primary" href={`https://venmo.com/u/${inv.pay.venmo}`} target="_blank" rel="noreferrer">Pay with Venmo: @{inv.pay.venmo}</a>
                <br /><span className="small">Amount <strong>{money(inv.amount_cents)}</strong> · note{' '}
                  <button className="linkish" onClick={async () => setCopied(await copy(inv.pay.note))}>{copied ? 'copied!' : `“${inv.pay.note}”`}</button>
                </span>
              </p>
            )}
            {inv.pay.zelle && <p><strong>Zelle:</strong> {inv.pay.zelle}</p>}
            {inv.pay.extra && <p>{inv.pay.extra}</p>}
            {!inv.pay.venmo && !inv.pay.zelle && !inv.pay.extra && <p className="muted">Your tutor will tell you how to pay.</p>}
          </div>
        )}
        {inv.family_token && <p className="small"><Link to={`/family/${inv.family_token}`}>Back to your family page</Link></p>}
      </section>
    </div>
  );
}

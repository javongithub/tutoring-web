import { useState } from 'react';
import { get, post } from '../../api.js';
import { copy, money, useLoad } from '../../util.js';
import { ErrorText, Loading, StatusPill, useAction } from '../../components/ui.jsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const label = (p) => `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;

export default function Invoices() {
  const [period, setPeriod] = useState('');
  const { data, error, reload } = useLoad(() => get(`/admin/invoices${period ? `?period=${period}` : ''}`), [period]);
  const act = useAction();
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(null);
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const total = data.preview.reduce((c, p) => c + p.amount_cents, 0);
  const doAct = (fn) => act.run(async () => { await fn(); reload(); });

  return (
    <div className="page">
      <div className="page-head">
        <h1>Invoices</h1>
        <label className="filters">Month <input type="month" value={period || data.period} onChange={(e) => setPeriod(e.target.value)} /></label>
      </div>

      <section className="card">
        <h2>Ready to bill: {label(data.period)}</h2>
        {data.preview.length === 0 ? <p className="muted">Nothing unbilled for this month. Logged, unpaid sessions show up here.</p> : (
          <>
            <ul className="list">
              {data.preview.map((p) => (
                <li key={p.student_id} className="list-row">
                  <span><strong>{p.name}</strong> <span className="muted">· {p.sessions} session{p.sessions === 1 ? '' : 's'}{p.email ? '' : ' · no email on file'}</span></span>
                  <strong>{money(p.amount_cents)}</strong>
                </li>
              ))}
            </ul>
            <div className="actions left">
              <button className="btn primary" disabled={act.busy} onClick={() => doAct(async () => setResult(await post('/admin/invoices', { period: data.period, send: true })))}>
                Create &amp; email {data.preview.length} invoice{data.preview.length === 1 ? '' : 's'} ({money(total)})
              </button>
              <button className="btn" disabled={act.busy} onClick={() => doAct(async () => setResult(await post('/admin/invoices', { period: data.period })))}>Create without emailing</button>
            </div>
          </>
        )}
        {result && (
          <p className="notice ok">
            Created {result.created}. Emailed {result.emailed}.
            {result.no_email > 0 && ` ${result.no_email} famil${result.no_email === 1 ? 'y has' : 'ies have'} no email: copy their link below and text it.`}
          </p>
        )}
        <ErrorText error={act.error} />
      </section>

      <section className="card">
        <h2>Invoices</h2>
        {data.invoices.length === 0 && <p className="muted">None yet.</p>}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Family</th><th>Month</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data.invoices.map((i) => (
                <tr key={i.id} className={i.status === 'void' ? 'muted' : ''}>
                  <td><strong>{i.student_name}</strong><div className="small muted">{i.sessions} sessions{i.sent_at ? ` · emailed ${i.sent_at.slice(0, 10)}` : ' · not emailed'}</div></td>
                  <td>{label(i.period)}</td>
                  <td className="num">{money(i.amount_cents)}</td>
                  <td><StatusPill status={i.status === 'paid' ? 'paid' : i.status === 'void' ? 'cancelled' : 'pending'}>{i.status}</StatusPill></td>
                  <td>
                    {i.status !== 'void' && (
                      <div className="row-actions">
                        <button className="btn subtle" onClick={async () => setCopied((await copy(`${window.location.origin}/invoice/${i.token}`)) ? i.id : null)}>{copied === i.id ? 'Copied!' : 'Copy link'}</button>
                        {i.status === 'open' && i.email && <button className="btn subtle" onClick={() => doAct(() => post(`/admin/invoices/${i.id}/send`))}>{i.sent_at ? 'Resend' : 'Email'}</button>}
                        {i.status === 'open' && <button className="btn" onClick={() => doAct(() => post(`/admin/invoices/${i.id}/paid`))}>Mark paid</button>}
                        {i.status === 'paid' && <button className="btn subtle" onClick={() => doAct(() => post(`/admin/invoices/${i.id}/paid`, { paid: 0 }))}>Mark unpaid</button>}
                        {i.status === 'open' && <button className="btn subtle danger" onClick={() => window.confirm('Void this invoice? Its sessions become billable again.') && doAct(() => post(`/admin/invoices/${i.id}/void`))}>Void</button>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">Set your Venmo/Zelle details and automatic monthly invoicing in Settings → Payments.</p>
      </section>
    </div>
  );
}

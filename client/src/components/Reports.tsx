import { useEffect, useState } from 'react';
import type { ReportRow, StudentRow } from '../../../server/types.ts';
import { del, patch, post } from '../api.ts';
import { addDays, copy } from '../util.ts';
import { ErrorText, StatusPill, useAction } from './ui.tsx';

const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// Progress reports for one student: draft (AI or manual), edit, send to the family.
export default function ReportsCard({ st, reports, aiEnabled, onChanged }: {
  st: StudentRow; reports: ReportRow[]; aiEnabled: boolean; onChanged: () => void;
}) {
  const [range, setRange] = useState({ from: addDays(todayLocal(), -30), to: todayLocal() });
  const act = useAction();
  const create = (ai: boolean) => act.run(async () => { await post(`/admin/students/${st.id}/reports`, { ...range, ai }); onChanged(); });
  return (
    <section className="card">
      <h2>Progress reports</h2>
      <p className="hint">
        {aiEnabled
          ? 'The AI drafts a short parent-friendly report from your session notes in this range. Read and edit it before sending: it only uses what you wrote.'
          : 'Write a short update for the parents. (Set ANTHROPIC_API_KEY on the server to have AI draft these from your notes.)'}
      </p>
      <div className="inline-form">
        <label className="small">From <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label className="small">To <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        {aiEnabled && <button className="btn primary" disabled={act.busy} onClick={() => create(true)}>{act.busy ? 'Drafting…' : 'Draft with AI'}</button>}
        <button className="btn" disabled={act.busy} onClick={() => create(false)}>Write manually</button>
      </div>
      <ErrorText error={act.error} />
      {reports.map((r) => <ReportItem key={r.id} r={r} onChanged={onChanged} />)}
    </section>
  );
}

function ReportItem({ r, onChanged }: { r: ReportRow; onChanged: () => void }) {
  const [body, setBody] = useState(r.body);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(r.status === 'draft');
  useEffect(() => setBody(r.body), [r.body]);
  const act = useAction();
  const dirty = body !== r.body;
  return (
    <div className="report">
      <div className="report-head" onClick={() => setOpen(!open)}>
        <strong>{r.period_from} → {r.period_to}</strong>{' '}
        <StatusPill status={r.status === 'sent' ? 'paid' : 'pending'}>{r.status === 'sent' ? `Sent ${r.sent_at?.slice(0, 10)}` : 'Draft'}</StatusPill>
        {r.source === 'ai' && <span className="tag">AI draft</span>}
      </div>
      {open && (r.status === 'draft' ? (
        <>
          <textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What we worked on, what's going well, what's hard, the plan…" />
          <ErrorText error={act.error} />
          <div className="actions left">
            <button className="btn" disabled={!dirty || act.busy} onClick={() => act.run(async () => { await patch(`/admin/reports/${r.id}`, { body }); onChanged(); })}>{dirty ? 'Save draft' : 'Saved'}</button>
            <button className="btn primary" disabled={act.busy || !body.trim()} onClick={() => act.run(async () => {
              if (dirty) await patch(`/admin/reports/${r.id}`, { body });
              if (!window.confirm('Send this report to the family? It will be emailed (if they have an email) and shown on their family page.')) return;
              await post(`/admin/reports/${r.id}/send`); onChanged();
            })}>Send to family</button>
            <button className="btn subtle danger" onClick={() => window.confirm('Delete this draft?') && act.run(async () => { await del(`/admin/reports/${r.id}`); onChanged(); })}>Delete</button>
          </div>
        </>
      ) : (
        <>
          <p className="report-body">{r.body}</p>
          <button className="btn subtle" onClick={async () => setCopied(await copy(`${window.location.origin}/report/${r.token}`))}>{copied ? 'Copied!' : 'Copy link'}</button>
        </>
      ))}
    </div>
  );
}

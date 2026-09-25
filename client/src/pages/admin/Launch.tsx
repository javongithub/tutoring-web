import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { LaunchStatus } from '../../../../server/api-types.ts';
import { get, patch, post } from '../../api.ts';
import { copy, useLoad } from '../../util.ts';
import { ErrorText, Loading } from '../../components/ui.tsx';

type Family = LaunchStatus['families'][number];

const message = (f: Family, url: string) =>
  `Hi${f.parent_name ? ` ${f.parent_name}` : ''}! Here's ${f.name}'s private tutoring page: ${url}/family/${f.portal_token}\n\n`
  + `You can see upcoming sessions, request extra ones, and ask to move or cancel (24 hours' notice please). Bookmark it!`;

// Everything needed to go live: a setup checklist and one-tap invites for each family.
export default function Launch() {
  const { data, error, reload } = useLoad(() => get<LaunchStatus>('/admin/launch'));
  const [copied, setCopied] = useState<number | null>(null);
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const done = data.checklist.filter((c) => c.done).length;
  const local = /localhost|127\.0\.0\.1|^http:/.test(data.public_url);
  const markInvited = (f: Family) => { void post(`/admin/students/${f.id}/invited`).then(reload); };

  return (
    <div className="page">
      <h1>Launch</h1>
      <section className="card">
        <h2>Setup checklist <span className="badge">{done}/{data.checklist.length}</span></h2>
        <ul className="checklist">
          {data.checklist.map((c) => (
            <li key={c.key} className={c.done ? 'done' : ''}>
              <span className="tick" aria-hidden="true">{c.done ? '✓' : ''}</span>
              <div><strong>{c.label}</strong>{!c.done && <div className="small muted">{c.hint}</div>}</div>
            </li>
          ))}
        </ul>
        <p className="small"><Link to="/admin/settings">Open Settings →</Link></p>
      </section>

      <section className="card">
        <h2>Send families their links</h2>
        {local ? (
          <p className="notice warn">
            Links currently point to <code>{data.public_url}</code>, which families can&rsquo;t open. Deploy first (README → Deploy), then invite.
          </p>
        ) : (
          <p className="hint">Each family gets a private link to their own page. Tap Text to open your phone&rsquo;s Messages app with the invite written for you.</p>
        )}
        <ul className="list">
          {data.families.map((f) => {
            const msg = message(f, data.public_url);
            return (
              <li key={f.id} className="list-row">
                <div>
                  <strong>{f.name}</strong>{f.invited && <span className="tag approved">sent</span>}
                  <div className="small muted">{[f.parent_name, f.phone, f.email].filter(Boolean).join(' · ') || 'No contact info yet'}</div>
                  {!f.phone && <AddPhone id={f.id} onSaved={reload} />}
                </div>
                <div className="row-actions">
                  {f.phone && <a className="btn" href={`sms:${f.phone.replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(msg)}`} onClick={() => markInvited(f)}>Text</a>}
                  {f.email && <a className="btn" href={`mailto:${f.email}?subject=${encodeURIComponent(`${f.name}'s tutoring page`)}&body=${encodeURIComponent(msg)}`} onClick={() => markInvited(f)}>Email</a>}
                  <button className="btn subtle" onClick={async () => { if (await copy(msg)) { setCopied(f.id); markInvited(f); } }}>
                    {copied === f.id ? 'Copied!' : 'Copy message'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        {data.families.length === 0 && <p className="muted">No students yet.</p>}
      </section>
    </div>
  );
}

// Quick way to add a parent's cell so the Text button appears.
function AddPhone({ id, onSaved }: { id: number; onSaved: () => void }) {
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<Error | null>(null);
  return (
    <form className="inline-form" onSubmit={(e) => {
      e.preventDefault();
      patch(`/admin/students/${id}`, { phone }).then(onSaved, (err: Error) => setError(err));
    }}>
      <input type="tel" placeholder="Parent's cell" value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Parent's cell" style={{ width: 150 }} />
      <button className="btn subtle" disabled={phone.replace(/\D/g, '').length < 10}>Add</button>
      <ErrorText error={error} />
    </form>
  );
}

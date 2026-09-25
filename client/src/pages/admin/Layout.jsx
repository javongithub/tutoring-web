import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { get, post } from '../../api.js';
import { ErrorText, useAction } from '../../components/ui.jsx';

const NAV = [
  ['/admin', 'Dashboard', true], ['/admin/calendar', 'Calendar'], ['/admin/students', 'Students'],
  ['/admin/log', 'Tutoring log'], ['/admin/cancellations', 'Cancellations'], ['/admin/waitlist', 'Waitlist'], ['/admin/settings', 'Settings'],
];

export default function AdminLayout() {
  const [authed, setAuthed] = useState(null);
  const nav = useNavigate();
  useEffect(() => {
    get('/auth/me').then((r) => setAuthed(r.admin)).catch(() => setAuthed(false));
    const onExpire = () => setAuthed(false);
    window.addEventListener('auth-expired', onExpire);
    return () => window.removeEventListener('auth-expired', onExpire);
  }, []);
  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return (
    <div className="admin">
      <nav className="sidebar">
        <div className="brand">Tutoring</div>
        {NAV.map(([to, label, end]) => <NavLink key={to} to={to} end={end}>{label}</NavLink>)}
        <div className="sidebar-foot">
          <a href="/" target="_blank" rel="noreferrer">Public page ↗</a>
          <button className="linkish" onClick={async () => { await post('/auth/logout'); setAuthed(false); nav('/admin'); }}>Log out</button>
        </div>
      </nav>
      <main className="admin-main"><Outlet /></main>
    </div>
  );
}

function Login({ onDone }) {
  const [pw, setPw] = useState('');
  const { busy, error, run } = useAction();
  return (
    <div className="login">
      <form className="card" onSubmit={(e) => { e.preventDefault(); run(async () => { await post('/auth/login', { password: pw }); onDone(); }); }}>
        <h1>Tutor login</h1>
        <label className="field"><span>Password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" /></label>
        <ErrorText error={error} />
        <button className="btn primary big" disabled={busy}>Log in</button>
      </form>
    </div>
  );
}

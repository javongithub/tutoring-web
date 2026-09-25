import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get, post } from '../../api.ts';
import { DAYS, fmtWhen, money, useLoad } from '../../util.ts';
import PublicWeek from '../../components/PublicWeek.tsx';
import { ErrorText, useAction } from '../../components/ui.tsx';

export default function Book() {
  const { data: info } = useLoad(() => get('/public/info'));
  const [slot, setSlot] = useState(null);
  const [f, setF] = useState({ parent_name: '', student_name: '', email: '', phone: '', message: '', website: '' });
  const { busy, error, run } = useAction();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const week = /^\d{4}-\d{2}-\d{2}$/.test(params.get('week') || '') ? params.get('week') : null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const { token } = await post('/public/requests', { ...f, start_at: slot.start_at });
      nav(`/booking/${token}`);
    });
  };

  return (
    <div className="public">
      <header className="hero">
        <h1>{info?.tutor_name || 'Tutoring'}</h1>
        <p>Pick an open time below and send a request. Every request is confirmed personally before it&rsquo;s booked.</p>
        {info && (
          <ul className="facts">
            <li><strong>{money(info.rate_cents)}</strong> per {info.slot_minutes}-minute session</li>
            <li>Book at least {info.min_notice_hours}h ahead</li>
            <li>{info.cancel_notice_hours}-hour cancellation &amp; reschedule policy</li>
          </ul>
        )}
      </header>

      <section className="card">
        <h2>1. Choose a time</h2>
        <PublicWeek onSlot={setSlot} selected={slot?.start_at} initialStart={week} />
      </section>

      <section className="card" id="details">
        <h2>2. Your details</h2>
        {!slot ? <p className="muted">Pick an open time above first.</p> : (
          <form onSubmit={submit} className="form">
            <p className="selected-slot">Requested: <strong>{fmtWhen(slot.start_at, slot.end_at)}</strong></p>
            <div className="grid2">
              <label className="field"><span>Parent / guardian name</span><input required value={f.parent_name} onChange={set('parent_name')} autoComplete="name" /></label>
              <label className="field"><span>Student name</span><input required value={f.student_name} onChange={set('student_name')} /></label>
              <label className="field"><span>Email</span><input required type="email" value={f.email} onChange={set('email')} autoComplete="email" /></label>
              <label className="field"><span>Phone (optional)</span><input type="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" /></label>
            </div>
            <label className="field"><span>Class / what you need help with</span><textarea rows={3} value={f.message} onChange={set('message')} placeholder="e.g. 8th grade math, test on Friday" /></label>
            <label className="hp" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} /></label>
            <ErrorText error={error} />
            <button className="btn primary big" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
          </form>
        )}
      </section>
      <Waitlist />
      <footer className="public-foot"><a href="/admin">Tutor login</a></footer>
    </div>
  );
}

function Waitlist() {
  const [f, setF] = useState({ parent_name: '', student_name: '', email: '', phone: '', note: '', website: '' });
  const [days, setDays] = useState([]);
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const toggle = (d) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d]);
  if (done) {
    return <section className="card"><h2>You&rsquo;re on the waitlist ✓</h2><p>We&rsquo;ll email you the moment a time opens up. Check your inbox for a confirmation.</p></section>;
  }
  return (
    <section className="card" id="waitlist">
      <h2>No time that works? Join the waitlist</h2>
      <p className="hint">When a slot opens up (cancellations happen), you get an email right away. First to request it gets it.</p>
      <form className="form" onSubmit={(e) => { e.preventDefault(); run(async () => { await post('/public/waitlist', { ...f, weekdays: days }); setDone(true); }); }}>
        <div className="grid2">
          <label className="field"><span>Parent / guardian name</span><input required value={f.parent_name} onChange={set('parent_name')} autoComplete="name" /></label>
          <label className="field"><span>Student name</span><input required value={f.student_name} onChange={set('student_name')} /></label>
          <label className="field"><span>Email</span><input required type="email" value={f.email} onChange={set('email')} autoComplete="email" /></label>
          <label className="field"><span>Phone (optional)</span><input type="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" /></label>
        </div>
        <fieldset className="days">
          <legend>Days that work (leave blank for any day)</legend>
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <label key={d} className={`day-chip ${days.includes(d) ? 'on' : ''}`}>
              <input type="checkbox" checked={days.includes(d)} onChange={() => toggle(d)} />{DAYS[d]}
            </label>
          ))}
        </fieldset>
        <label className="field"><span>Anything else? (optional)</span><input value={f.note} onChange={set('note')} placeholder="e.g. after 5pm only, AP Calc" /></label>
        <label className="hp" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} /></label>
        <ErrorText error={error} />
        <button className="btn primary" disabled={busy}>Join the waitlist</button>
      </form>
    </section>
  );
}

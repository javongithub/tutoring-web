import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post } from '../../api.js';
import { fmtWhen, money, useLoad } from '../../util.js';
import PublicWeek from '../../components/PublicWeek.jsx';
import { ErrorText, useAction } from '../../components/ui.jsx';

export default function Book() {
  const { data: info } = useLoad(() => get('/public/info'));
  const [slot, setSlot] = useState(null);
  const [f, setF] = useState({ parent_name: '', student_name: '', email: '', phone: '', message: '', website: '' });
  const { busy, error, run } = useAction();
  const nav = useNavigate();
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
        <PublicWeek onSlot={setSlot} selected={slot?.start_at} />
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
      <footer className="public-foot"><a href="/admin">Tutor login</a></footer>
    </div>
  );
}

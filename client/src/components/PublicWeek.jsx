import { useState } from 'react';
import { get } from '../api.js';
import { useLoad, weekStart } from '../util.js';
import WeekGrid, { Legend, WeekNav } from './WeekGrid.jsx';
import { ErrorText, Loading } from './ui.jsx';

// The tutor's week as a family sees it: their own sessions by name, everyone else as
// "Other student", everything else as "Busy", plus open slots to pick.
export default function PublicWeek({ family, onSlot, selected, hideSlots, initialStart = null }) {
  const [start, setStart] = useState(initialStart);
  const q = new URLSearchParams({ ...(start ? { start } : {}), ...(family ? { family } : {}) });
  const { data, error, loading } = useLoad(() => get(`/public/week?${q}`), [start, family]);
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const items = data.occupied.map((o) => ({
    ...o,
    title: o.label,
    kind: o.kind === 'own' ? (o.status === 'pending' || o.status === 'requested' ? 'pending' : 'own') : o.kind === 'student' ? 'other' : 'busy',
  }));
  return (
    <div className={loading ? 'is-loading' : ''}>
      <WeekNav start={data.start} onChange={setStart} min={weekStart(data.today)} max={data.max_date} />
      <WeekGrid start={data.start} today={data.today} items={items} slots={hideSlots ? [] : data.slots} onSlot={onSlot} selected={selected} />
      <Legend items={[
        ...(hideSlots ? [] : [['slot', 'Open — tap to pick']]),
        ...(family ? [['own', 'Your sessions'], ['pending', 'Waiting for approval']] : []),
        ['other', 'Other student'], ['busy', 'Busy'],
      ]} />
      {!hideSlots && data.slots.length === 0 && <p className="muted center">No open times this week — try the next one.</p>}
    </div>
  );
}

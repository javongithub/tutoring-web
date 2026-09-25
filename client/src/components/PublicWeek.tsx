import { useState } from 'react';
import type { PublicWeek as Week } from '../../../server/api-types.ts';
import type { Slot } from '../../../server/types.ts';
import { get } from '../api.ts';
import { useLoad, weekStart } from '../util.ts';
import WeekGrid, { type GridItem, type ItemKind, Legend, WeekNav } from './WeekGrid.tsx';
import { ErrorText, Loading } from './ui.tsx';

// The tutor's week as a family sees it: their own sessions by name, everyone else as
// "Other student", everything else as "Busy", plus open slots to pick.
export default function PublicWeek({ family, onSlot, selected, hideSlots = false, initialStart = null }: {
  family?: string | null;
  onSlot?: (s: Slot) => void;
  selected?: string;
  hideSlots?: boolean;
  initialStart?: string | null;
}) {
  const [start, setStart] = useState<string | null>(initialStart);
  const q = new URLSearchParams({ ...(start ? { start } : {}), ...(family ? { family } : {}) });
  const { data, error, loading } = useLoad(() => get<Week>(`/public/week?${q}`), [start, family]);
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const items: GridItem[] = data.occupied.map((o) => ({
    ...o,
    title: o.label,
    kind: o.kind === 'own' ? (o.status === 'pending' || o.status === 'requested' ? 'pending' : 'own') : o.kind === 'student' ? 'other' : 'busy',
  }));
  const legend: [ItemKind, string][] = [
    ...(hideSlots ? [] : [['slot', 'Open — tap to pick']] as [ItemKind, string][]),
    ...(family ? [['own', 'Your sessions'], ['pending', 'Waiting for approval']] as [ItemKind, string][] : []),
    ['other', 'Other student'], ['busy', 'Busy'],
  ];
  return (
    <div className={loading ? 'is-loading' : ''}>
      <WeekNav start={data.start} onChange={setStart} min={weekStart(data.today)} max={data.max_date} />
      <WeekGrid start={data.start} today={data.today} items={items} slots={hideSlots ? [] : data.slots} onSlot={onSlot} selected={selected} />
      <Legend items={legend} />
      {!hideSlots && data.slots.length === 0 && <p className="muted center">No open times this week — try the next one.</p>}
    </div>
  );
}

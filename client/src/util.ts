import { type ChangeEvent, type DependencyList, useCallback, useEffect, useState } from 'react';
import type { SessionStatus } from '../../server/types.ts';

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Dates are naive local strings "YYYY-MM-DD" / "YYYY-MM-DDTHH:MM"; math is done in UTC.
const toMs = (s: string): number => {
  const [d, t = '00:00'] = s.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  return Date.UTC(y, m - 1, dd, h, mi);
};
const pad = (n: number): string => String(n).padStart(2, '0');
export const addDays = (d: string, n: number): string => {
  const x = new Date(toMs(d) + n * 86400000);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
};
export const weekday = (d: string): number => new Date(toMs(d.slice(0, 10))).getUTCDay();
export const weekStart = (d: string): string => { const w = weekday(d); return addDays(d, w === 0 ? -6 : 1 - w); };
export const minutesOf = (s: string): number => { const [h, m] = s.slice(-5).split(':').map(Number); return h * 60 + m; };
export const durationMin = (a: string, b: string): number => Math.round((toMs(b) - toMs(a)) / 60000);
export const addMinutes = (s: string, n: number): string => {
  const x = new Date(toMs(s) + n * 60000);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}T${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`;
};

export function fmtTime(s: string): string {
  const [h, m] = s.slice(-5).split(':').map(Number);
  const hh = h % 12 || 12;
  return `${hh}${m ? `:${pad(m)}` : ''}${h < 12 ? 'am' : 'pm'}`;
}
export const fmtRange = (a: string, b: string): string => `${fmtTime(a)} – ${fmtTime(b)}`;
export function fmtDate(s: string, { long = false }: { long?: boolean } = {}): string {
  const d = s.slice(0, 10);
  const [, m, dd] = d.split('-').map(Number);
  return `${(long ? DAYS_LONG : DAYS)[weekday(d)]}, ${MONTHS[m - 1]} ${dd}`;
}
export const fmtWhen = (s: string, e?: string | null): string => `${fmtDate(s)} · ${e ? fmtRange(s, e) : fmtTime(s)}`;
export const money = (cents: number): string => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

export const STATUS_LABEL: Record<SessionStatus, string> = {
  pending: 'Awaiting approval', confirmed: 'Scheduled', completed: 'Done', cancelled: 'Cancelled',
  declined: 'Declined', no_show: 'No-show',
};

export interface Loaded<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => Promise<void>;
}

// Tiny data hook: { data, error, loading, reload }
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList = []): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: true });
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    return fn().then((data) => setState({ data, error: null, loading: false }))
      .catch((error: Error) => setState({ data: null, error, loading: false }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void load(); }, [load]);
  return { ...state, reload: load };
}

export async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** onChange event of any form field. */
export type FieldEvent = ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
/** Checkbox -> 1/0, anything else -> its string value. */
export const fieldValue = (e: FieldEvent): string | number =>
  (e.target instanceof HTMLInputElement && e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.value);

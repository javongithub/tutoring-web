import { type ReactNode, useEffect, useState } from 'react';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const ErrorText = ({ error }: { error: Error | string | null | undefined }) =>
  (error ? <p className="error" role="alert">{typeof error === 'string' ? error : error.message}</p> : null);

export const Loading = () => <p className="muted">Loading…</p>;

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function StatusPill({ status, children }: { status: string; children: ReactNode }) {
  return <span className={`pill pill-${status}`}>{children}</span>;
}

// Runs an async action and exposes busy/error state for buttons and forms.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(e instanceof Error ? e : new Error(String(e))); return undefined; } finally { setBusy(false); }
  };
  return { busy, error, run, setError };
}

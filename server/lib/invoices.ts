// Monthly invoices: one per family per month, covering sessions that were done (or
// billed as late cancels / no-shows) and not yet paid.
import { type DB, all, getSettings, newToken, one, run, scalar, tx } from '../db.ts';
import type { InvoiceRow, SessionRow } from '../types.ts';
import type { Notifier } from './notify.ts';
import { type DateStr, addDays, fmtWhen, nowLocal, today } from './time.ts';

export interface InvoicePreview {
  student_id: number;
  name: string;
  parent_name: string;
  email: string;
  sessions: number;
  amount_cents: number;
}
export interface InvoiceDetail extends InvoiceRow {
  student_name: string;
  parent_name: string;
  email: string;
  portal_token: string;
  items: Pick<SessionRow, 'id' | 'start_at' | 'end_at' | 'status' | 'rate_cents' | 'paid'>[];
}

const BILLABLE = "(s.status = 'completed' OR s.charged = 1)";
const money = (c: number): string => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const periodLabel = (p: string): string => `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
export const isPeriod = (p: unknown): p is string => typeof p === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p);
export const prevPeriod = (d: DateStr = today()): string => addDays(`${d.slice(0, 7)}-01`, -1).slice(0, 7);
const periodRange = (p: string): [string, string] => [`${p}-01T00:00`, `${addDays(`${p}-28`, 7).slice(0, 7)}-01T00:00`];

// Families with billable, unpaid, not-yet-invoiced sessions in the month.
export function invoicePreview(db: DB, period: string): InvoicePreview[] {
  const [from, to] = periodRange(period);
  return all<InvoicePreview>(db,
    `SELECT st.id AS student_id, st.name, st.parent_name, st.email, COUNT(*) AS sessions, SUM(s.rate_cents) AS amount_cents
       FROM sessions s JOIN students st ON st.id = s.student_id
      WHERE ${BILLABLE} AND s.paid = 0 AND s.invoice_id IS NULL AND s.start_at >= ? AND s.start_at < ?
      GROUP BY st.id ORDER BY st.name COLLATE NOCASE`,
    from, to);
}

function recalc(db: DB, invoiceId: number): void {
  const { total } = scalar<{ total: number }>(db, 'SELECT COALESCE(SUM(rate_cents), 0) AS total FROM sessions WHERE invoice_id = ?', invoiceId);
  run(db, 'UPDATE invoices SET amount_cents = ? WHERE id = ?', total, invoiceId);
}

// Create (or top up) invoices for the month. Returns the invoice ids touched.
export function createInvoices(db: DB, period: string, studentIds: number[] | null = null): number[] {
  const [from, to] = periodRange(period);
  const ids: number[] = [];
  tx(db, () => {
    for (const p of invoicePreview(db, period)) {
      if (studentIds && !studentIds.includes(p.student_id)) continue;
      let inv: Pick<InvoiceRow, 'id'> | undefined = one<InvoiceRow>(db, "SELECT * FROM invoices WHERE student_id = ? AND period = ? AND status = 'open'", p.student_id, period);
      if (!inv) {
        if (one(db, "SELECT 1 FROM invoices WHERE student_id = ? AND period = ? AND status = 'paid'", p.student_id, period)) {
          // Already paid this month; late-logged sessions go on a fresh invoice next month.
          continue;
        }
        const id = run(db, 'INSERT INTO invoices (student_id, period, token, created_at) VALUES (?, ?, ?, ?)',
          p.student_id, period, newToken(), nowLocal()).lastInsertRowid;
        inv = { id: Number(id) };
      }
      run(db, `UPDATE sessions AS s SET invoice_id = ? WHERE student_id = ? AND ${BILLABLE} AND paid = 0
                   AND invoice_id IS NULL AND start_at >= ? AND start_at < ?`, inv.id, p.student_id, from, to);
      recalc(db, inv.id);
      ids.push(inv.id);
    }
  });
  return ids;
}

export function invoiceDetail(db: DB, where: 'i.id = ?' | 'i.token = ?', arg: number | string): InvoiceDetail | null {
  const inv = one<InvoiceDetail>(db,
    `SELECT i.*, st.name AS student_name, st.parent_name, st.email, st.portal_token
       FROM invoices i JOIN students st ON st.id = i.student_id WHERE ${where}`,
    arg);
  if (!inv) return null;
  inv.items = all<InvoiceDetail['items'][number]>(db,
    'SELECT id, start_at, end_at, status, rate_cents, paid FROM sessions WHERE invoice_id = ? ORDER BY start_at', inv.id);
  return inv;
}

export function paymentInstructions(db: DB, inv: Pick<InvoiceDetail, 'student_name' | 'period'>) {
  const st = getSettings(db);
  const note = `${inv.student_name} tutoring ${periodLabel(inv.period)}`;
  const lines: string[] = [];
  if (st.venmo_handle) lines.push(`Venmo: @${st.venmo_handle.replace(/^@/, '')} (note: "${note}")`);
  if (st.zelle_contact) lines.push(`Zelle: ${st.zelle_contact}`);
  if (st.payment_note) lines.push(st.payment_note);
  return { lines, note, venmo: st.venmo_handle.replace(/^@/, ''), zelle: st.zelle_contact, extra: st.payment_note };
}

export function sendInvoice(db: DB, notify: Notifier, inv: InvoiceDetail, reqOrigin?: string): void {
  const pay = paymentInstructions(db, inv);
  const items = inv.items.map((s) => `  ${fmtWhen(s.start_at, s.end_at)}  ${money(s.rate_cents)}${s.status !== 'completed' ? ` (${s.status === 'no_show' ? 'no-show' : 'late cancellation'})` : ''}`).join('\n');
  notify.family(inv.email, `Tutoring invoice for ${inv.student_name}, ${periodLabel(inv.period)}: ${money(inv.amount_cents)}`,
    `Hi ${inv.parent_name || 'there'}! Here's ${inv.student_name}'s tutoring for ${periodLabel(inv.period)}:\n\n${items}\n\n`
      + `Total: ${money(inv.amount_cents)} (${inv.items.length} session${inv.items.length === 1 ? '' : 's'})\n\n`
      + (pay.lines.length ? `How to pay:\n${pay.lines.map((l) => `  ${l}`).join('\n')}\n\n` : '')
      + 'Invoice online:',
    { path: `/invoice/${inv.token}`, reqOrigin, force: true });
  run(db, 'UPDATE invoices SET sent_at = ? WHERE id = ?', nowLocal(), inv.id);
}

export function markInvoicePaid(db: DB, invoiceId: number, paid = true): void {
  tx(db, () => {
    run(db, "UPDATE invoices SET status = ?, paid_at = ? WHERE id = ? AND status <> 'void'", paid ? 'paid' : 'open', paid ? nowLocal() : null, invoiceId);
    run(db, 'UPDATE sessions SET paid = ? WHERE invoice_id = ?', paid ? 1 : 0, invoiceId);
  });
}

export function voidInvoice(db: DB, invoiceId: number): void {
  tx(db, () => {
    run(db, "UPDATE invoices SET status = 'void' WHERE id = ?", invoiceId);
    run(db, 'UPDATE sessions SET invoice_id = NULL WHERE invoice_id = ? AND paid = 0', invoiceId);
  });
}

// Keep invoice status in line when sessions are marked paid one at a time.
export function syncInvoiceStatus(db: DB, invoiceId: number | null): void {
  if (!invoiceId) return;
  const r = scalar<{ n: number; p: number | null }>(db, 'SELECT COUNT(*) AS n, SUM(paid) AS p FROM sessions WHERE invoice_id = ?', invoiceId);
  const inv = one<Pick<InvoiceRow, 'status'>>(db, 'SELECT status FROM invoices WHERE id = ?', invoiceId);
  if (!inv || inv.status === 'void') return;
  const allPaid = r.n > 0 && r.p === r.n;
  if (allPaid && inv.status !== 'paid') run(db, "UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?", nowLocal(), invoiceId);
  if (!allPaid && inv.status === 'paid') run(db, "UPDATE invoices SET status = 'open', paid_at = NULL WHERE id = ?", invoiceId);
}

// On/after the 1st: bill last month once (if auto-invoicing is on).
export function autoInvoice(db: DB, notify: Notifier): number[] | null {
  const st = getSettings(db);
  const period = prevPeriod();
  if (!st.auto_invoice || st.last_auto_invoice === period) return null;
  const ids = createInvoices(db, period);
  for (const id of ids) {
    const inv = invoiceDetail(db, 'i.id = ?', id);
    if (inv?.email) sendInvoice(db, notify, inv);
  }
  run(db, "UPDATE settings SET value = ? WHERE key = 'last_auto_invoice'", period);
  if (ids.length) {
    const total = scalar<{ t: number }>(db, `SELECT SUM(amount_cents) AS t FROM invoices WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).t;
    notify.tutor(`Invoices sent for ${periodLabel(period)}`, `${ids.length} famil${ids.length === 1 ? 'y' : 'ies'}, ${money(total)} total.`, { path: '/admin/invoices' });
  }
  return ids;
}

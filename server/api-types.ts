// Response shapes of the HTTP API: the contract between server/routes and the React client.
// Routes check their responses against these with `satisfies`; the client imports them.
// Type-only and dependency-free so it's safe to import from the browser bundle.
import type {
  AuditRow, CalendarEventRow, ChangeRow, ChangeView, DateStr, DateTimeStr, InvoicePreview, InvoiceRow, MoneyRow,
  Occupied, OutboxRow, ReportRow, RuleRow, SessionStatus, SessionView, Settings, Slot, StudentRow, WaitlistRow, WeeklyRow,
} from './types.ts';

// ---------- Public (families) ----------

export interface PublicInfo {
  tutor_name: string;
  slot_minutes: number;
  booking_weeks_ahead: number;
  cancel_notice_hours: number;
  min_notice_hours: number;
  today: DateStr;
  rate_cents: number;
}

export interface PublicWeek {
  start: DateStr;
  today: DateStr;
  max_date: DateStr;
  occupied: Occupied[];
  slots: Slot[];
}

/** A session as a family sees it. Never includes other families' data. */
export interface PublicSession {
  token: string;
  start_at: DateTimeStr;
  end_at: DateTimeStr;
  status: SessionStatus;
  student: string | null;
  cancelled_by: 'client' | 'tutor' | null;
  late_cancel: 0 | 1;
  change_request: Pick<ChangeRow, 'kind' | 'new_start_at' | 'new_end_at' | 'reason' | 'requested_at'> | null;
  last_decision: Pick<ChangeRow, 'kind' | 'new_start_at' | 'status' | 'tutor_note' | 'decided_at'> | null;
  can_request_change: boolean;
  /** Inside the cancellation window: allowed, but the family must acknowledge `policy`. */
  late_window: boolean;
  policy: string | null;
  can_withdraw: boolean;
}

export interface PublicBooking extends PublicSession {
  family_token: string | null;
}

export interface FamilyPage {
  student: string;
  parent: string;
  cancel_notice_hours: number;
  upcoming: PublicSession[];
  cancelled: PublicSession[];
  reports: Pick<ReportRow, 'token' | 'period_from' | 'period_to' | 'sent_at'>[];
  invoices: (Pick<InvoiceRow, 'token' | 'period' | 'amount_cents' | 'status'> & { period_label: string })[];
  recent: PublicSession[];
}

export interface PaymentInfo { lines: string[]; note: string; venmo: string; zelle: string; extra: string }

export interface PublicInvoice {
  tutor_name: string;
  student: string;
  parent: string;
  period: string;
  period_label: string;
  status: InvoiceRow['status'];
  amount_cents: number;
  paid_at: string | null;
  family_token: string;
  items: { start_at: DateTimeStr; end_at: DateTimeStr; status: SessionStatus; rate_cents: number }[];
  pay: PaymentInfo;
}

export interface PublicReport extends Pick<ReportRow, 'body' | 'period_from' | 'period_to' | 'sent_at'> {
  student: string;
  portal_token: string;
  tutor_name: string;
}

export type PublicWaitlistEntry = Pick<WaitlistRow, 'student_name' | 'status' | 'weekdays' | 'created_at'>;

// ---------- Admin ----------

export interface Dashboard {
  now: DateTimeStr;
  earnings: { week: MoneyRow; month: MoneyRow; all_time: MoneyRow; unpaid: MoneyRow; scheduled_week: MoneyRow };
  pending: SessionView[];
  changes: ChangeView[];
  needs_log: SessionView[];
  upcoming: SessionView[];
  recent_cancels: SessionView[];
}

export interface WeekSessions { sessions: SessionView[]; calendar: CalendarEventRow[]; blocks: WeeklyRow[] }

export interface StudentListItem extends StudentRow {
  completed: number;
  client_cancels: number;
  unpaid_cents: number;
  next_session: DateTimeStr | null;
}

export interface StudentStats {
  completed: number | null;
  client_cancels: number | null;
  late_cancels: number | null;
  tutor_cancels: number | null;
  no_shows: number | null;
  earned_cents: number;
  unpaid_cents: number;
}

export interface StudentDetail {
  student: StudentRow;
  ai_enabled: boolean;
  reports: ReportRow[];
  rules: RuleRow[];
  sessions: SessionView[];
  upcoming: SessionView[];
  stats: StudentStats;
}

export interface TutoringLog {
  rows: SessionView[];
  totals: { sessions: number; hours: number; earned_cents: number; unpaid_cents: number };
}

export interface CancellationStat {
  id: number;
  name: string;
  client_cancels: number;
  late_cancels: number;
  no_shows: number;
  tutor_cancels: number;
  total: number;
  lost_cents: number;
}
export interface Cancellations { rows: SessionView[]; by_student: CancellationStat[]; from: DateStr; to: DateStr }

export interface SettingsPage {
  email_enabled: boolean;
  outbox: Pick<OutboxRow, 'id' | 'channel' | 'to_addr' | 'subject' | 'created_at' | 'sent_at' | 'attempts' | 'last_error'>[];
  settings: Settings;
  gcal_service_account: string | null;
  availability: WeeklyRow[];
  blocks: WeeklyRow[];
}

export interface TutoringSeries {
  key: string;
  summary: string;
  weekday: number;
  start_time: string;
  duration_min: number;
  first: DateStr;
  count: number;
  name: string;
  parent: string;
  imported_as: string | null;
}

export interface InvoiceListItem extends InvoiceRow { student_name: string; email: string; sessions: number }
export interface InvoicesPage { period: string; preview: InvoicePreview[]; invoices: InvoiceListItem[] }
export interface InvoiceCreated { created: number; emailed: number; no_email: number }

export interface Audit { events: AuditRow[]; failed_logins_24h: number }

export interface NotifyTest { sent: number; pending: number; last: Pick<OutboxRow, 'channel' | 'sent_at' | 'last_error'>[] }

export type ReportView = ReportRow & { student_name: string; email: string; parent_name: string; portal_token: string };

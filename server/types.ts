// Row shapes for the SQLite tables (see SCHEMA in db.ts). Booleans are 0/1 integers.
// Dependency-free on purpose: the React client imports these types too.

import type { DEFAULT_SETTINGS } from './settings.ts';

export type Settings = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof Settings;

/** "YYYY-MM-DD" */
export type DateStr = string;
/** "YYYY-MM-DDTHH:MM" local wall-clock time */
export type DateTimeStr = string;

export type Flag = 0 | 1;
export type SessionStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'declined' | 'no_show';

export interface StudentRow {
  id: number;
  name: string;
  parent_name: string;
  email: string;
  phone: string;
  grade: string;
  subject: string;
  rate_cents: number;
  notes: string;
  next_plan: string;
  active: Flag;
  portal_token: string;
  created_at: string;
}

export interface RuleRow {
  id: number;
  student_id: number;
  weekday: number;
  start_time: string;
  duration_min: number;
  starts_on: DateStr;
  ends_on: DateStr | null;
  active: Flag;
}

export interface SessionRow {
  id: number;
  student_id: number | null;
  recurring_id: number | null;
  start_at: DateTimeStr;
  end_at: DateTimeStr;
  status: SessionStatus;
  source: 'tutor' | 'booking';
  rate_cents: number;
  paid: Flag;
  charged: Flag;
  topics: string;
  notes: string;
  next_plan: string;
  cancelled_by: 'client' | 'tutor' | null;
  cancel_reason: string;
  cancelled_at: DateTimeStr | null;
  late_cancel: Flag;
  requester_name: string;
  requester_student: string;
  requester_email: string;
  requester_phone: string;
  requester_message: string;
  token: string;
  slot_key: DateTimeStr | null;
  reminded: Flag;
  invoice_id: number | null;
  gcal_event_id: string | null;
  gcal_dirty: Flag;
  created_at: string;
}

/** A session joined with its student (the shape most queries return). */
export interface SessionView extends SessionRow {
  student_name: string | null;
  parent_name: string | null;
  student_next_plan: string | null;
}

export interface ChangeRow {
  id: number;
  session_id: number;
  kind: 'cancel' | 'reschedule';
  new_start_at: DateTimeStr | null;
  new_end_at: DateTimeStr | null;
  reason: string;
  late: Flag;
  policy_ack: Flag;
  status: 'pending' | 'approved' | 'declined' | 'withdrawn';
  tutor_note: string;
  requested_at: DateTimeStr;
  decided_at: DateTimeStr | null;
}

export interface ChangeView extends ChangeRow {
  start_at: DateTimeStr;
  end_at: DateTimeStr;
  session_status: SessionStatus;
  recurring_id: number | null;
  student_name: string | null;
  parent_name: string | null;
}

export interface CalendarEventRow {
  id: number;
  uid: string;
  summary: string;
  start_at: DateTimeStr;
  end_at: DateTimeStr;
  is_tutoring: Flag;
  from_app: Flag;
}

export interface WeeklyRow {
  id: number;
  weekday: number;
  start_time: string;
  end_time: string;
  label?: string;
}

export interface WaitlistRow {
  id: number;
  parent_name: string;
  student_name: string;
  email: string;
  phone: string;
  weekdays: string;
  note: string;
  status: 'active' | 'booked' | 'removed';
  token: string;
  created_at: string;
  last_notified_at: DateTimeStr | null;
}

export interface InvoiceRow {
  id: number;
  student_id: number;
  period: string;
  amount_cents: number;
  status: 'open' | 'paid' | 'void';
  token: string;
  created_at: string;
  sent_at: string | null;
  paid_at: string | null;
}

export interface ReportRow {
  id: number;
  student_id: number;
  period_from: DateStr;
  period_to: DateStr;
  body: string;
  status: 'draft' | 'sent';
  source: 'ai' | 'manual';
  token: string;
  created_at: string;
  sent_at: string | null;
}

export interface OutboxRow {
  id: number;
  channel: 'email' | 'push';
  to_addr: string;
  subject: string;
  body: string;
  link: string;
  created_at: string;
  sent_at: string | null;
  attempts: number;
  last_error: string;
}

/** Aggregate rows. */
export interface CountRow { n: number }
export interface MoneyRow { n: number; cents: number }

/** Something occupying the tutor's time, labelled for a particular viewer. */
export interface Occupied {
  start_at: DateTimeStr;
  end_at: DateTimeStr;
  /** 'own' = the viewing family's session, 'student' = another family, 'busy' = anything else. */
  kind: 'own' | 'student' | 'busy';
  label: string;
  id?: number;
  status?: string;
}
export interface Slot { start_at: DateTimeStr; end_at: DateTimeStr }

export interface InvoicePreview {
  student_id: number;
  name: string;
  parent_name: string;
  email: string;
  sessions: number;
  amount_cents: number;
}

export interface AuditRow { id: number; at: string; ip: string; action: string; status: number }

// Default settings (stored in the `settings` table; editable in Admin → Settings).
// Dependency-free so the client can derive the Settings type from it.
export const DEFAULT_SETTINGS = {
  tutor_name: 'Tutoring',
  default_rate_cents: 3000,
  slot_minutes: 60,
  min_notice_hours: 24,
  booking_weeks_ahead: 4,
  cancel_notice_hours: 24,
  charge_late_cancels: 0,
  ics_url: '',
  ics_synced_at: '',
  ics_error: '',
  gcal_calendar_id: '',
  gcal_error: '',
  notify_email: '',          // where YOU get emailed about requests
  ntfy_url: '',              // e.g. https://ntfy.sh/tutoring-x7k2… for phone push
  email_families: 1,         // email parents about confirmations, decisions, changes
  reminders: 0,              // email parents the evening before each session
  reminder_hour: 18,
  public_url: '',
  venmo_handle: '',
  zelle_contact: '',
  payment_note: '',
  auto_invoice: 0,           // create + email last month's invoices on the 1st
  last_auto_invoice: '',
  session_epoch: 0,          // bump to invalidate every admin session ("log out everywhere")
  gcal_synced_at: '',
  feed_token: '',
};

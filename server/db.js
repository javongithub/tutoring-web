import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const newToken = () => randomBytes(18).toString('base64url');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  rate_cents INTEGER NOT NULL DEFAULT 3000,
  notes TEXT NOT NULL DEFAULT '',
  next_plan TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  portal_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Weekly repeating sessions ("Alex every Monday 3:30").
CREATE TABLE IF NOT EXISTS recurring (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60,
  starts_on TEXT NOT NULL,
  ends_on TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- Every session, including booking requests from the website (status = 'pending').
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  recurring_id INTEGER REFERENCES recurring(id) ON DELETE SET NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('pending','confirmed','completed','cancelled','declined','no_show')),
  source TEXT NOT NULL DEFAULT 'tutor' CHECK (source IN ('tutor','booking')),
  rate_cents INTEGER NOT NULL DEFAULT 3000,
  paid INTEGER NOT NULL DEFAULT 0,
  charged INTEGER NOT NULL DEFAULT 0,          -- late cancel / no-show that is still billed
  topics TEXT NOT NULL DEFAULT '',             -- what we covered
  notes TEXT NOT NULL DEFAULT '',              -- how it went
  next_plan TEXT NOT NULL DEFAULT '',          -- what to do next time
  cancelled_by TEXT CHECK (cancelled_by IN ('client','tutor')),
  cancel_reason TEXT NOT NULL DEFAULT '',
  cancelled_at TEXT,
  late_cancel INTEGER NOT NULL DEFAULT 0,
  requester_name TEXT NOT NULL DEFAULT '',
  requester_student TEXT NOT NULL DEFAULT '',
  requester_email TEXT NOT NULL DEFAULT '',
  requester_phone TEXT NOT NULL DEFAULT '',
  requester_message TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL UNIQUE,
  -- For weekly-schedule sessions: the originally scheduled start. Stays fixed when a
  -- single week is moved, so the schedule never regenerates the old slot.
  slot_key TEXT,
  reminded INTEGER NOT NULL DEFAULT 0,
  gcal_event_id TEXT,
  gcal_dirty INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (recurring_id, slot_key)
);
CREATE INDEX IF NOT EXISTS sessions_start ON sessions(start_at);
CREATE INDEX IF NOT EXISTS sessions_student ON sessions(student_id, start_at);

-- A family asking to cancel or move a session. Nothing changes until the tutor approves.
CREATE TABLE IF NOT EXISTS change_requests (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cancel','reschedule')),
  new_start_at TEXT,
  new_end_at TEXT,
  reason TEXT NOT NULL DEFAULT '',
  late INTEGER NOT NULL DEFAULT 0,             -- asked inside the cancellation notice window
  policy_ack INTEGER NOT NULL DEFAULT 0,       -- family ticked "I understand the 24-hour policy"
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','withdrawn')),
  tutor_note TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS change_requests_status ON change_requests(status);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_change ON change_requests(session_id) WHERE status = 'pending';

-- Any change that affects what Google Calendar should show marks the row for re-sync.
CREATE TRIGGER IF NOT EXISTS sessions_gcal_dirty AFTER UPDATE OF start_at, end_at, status, student_id ON sessions
BEGIN UPDATE sessions SET gcal_dirty = 1 WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS students_gcal_dirty AFTER UPDATE OF name ON students
BEGIN UPDATE sessions SET gcal_dirty = 1 WHERE student_id = NEW.id; END;

-- Windows when families may book on the website.
CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

-- Weekly commitments that block booking (classes, clubs).
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

-- Cached instances from the tutor's Google Calendar (iCal feed). Refreshed on sync.
CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL,
  summary TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  is_tutoring INTEGER NOT NULL DEFAULT 0,
  from_app INTEGER NOT NULL DEFAULT 0          -- an event this app pushed to Google Calendar
);
CREATE INDEX IF NOT EXISTS calendar_events_start ON calendar_events(start_at);

-- Notifications waiting to go out (email or phone push). A worker drains it and retries.
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email','push')),
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS outbox_unsent ON outbox(sent_at, attempts);

-- Families waiting for a slot. They're emailed when times open up.
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY,
  parent_name TEXT NOT NULL,
  student_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  weekdays TEXT NOT NULL DEFAULT '',        -- "1,2,5" = Mon/Tue/Fri; '' = any day
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','booked','removed')),
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_notified_at TEXT
);
-- Open slots already announced to the waitlist. Rows are pruned when a slot stops being
-- open, so a time that frees up again is announced again.
CREATE TABLE IF NOT EXISTS waitlist_announced (
  start_at TEXT PRIMARY KEY,
  announced_at TEXT NOT NULL
);

-- One bill per family per month. Sessions point at the invoice that covers them.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  period TEXT NOT NULL,                     -- "2026-10"
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  paid_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_invoice_per_month ON invoices(student_id, period) WHERE status <> 'void';

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

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
  gcal_synced_at: '',
  feed_token: '',
};

// Columns added after the first release. CREATE TABLE IF NOT EXISTS won't add them to an
// existing database, so add any that are missing. Append here; never edit old entries.
const MIGRATIONS = [
  ['sessions', 'reminded', 'INTEGER NOT NULL DEFAULT 0'],
  ['change_requests', 'policy_ack', 'INTEGER NOT NULL DEFAULT 0'],
  ['sessions', 'invoice_id', 'INTEGER REFERENCES invoices(id) ON DELETE SET NULL'],
];

function migrate(db) {
  for (const [table, column, ddl] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function openDb(file = process.env.DB_PATH || 'data/tutoring.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, String(v));
  db.prepare("UPDATE settings SET value = ? WHERE key = 'feed_token' AND value = ''").run(newToken());
  return db;
}

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    out[key] = typeof DEFAULT_SETTINGS[key] === 'number' ? Number(value) : value;
  }
  return out;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

import { openDb } from './db.ts';
import { createApp } from './app.ts';
import { materializeRecurring, syncCalendar } from './lib/schedule.ts';
import { createGcal, loadServiceAccount, pushDirty } from './lib/gcal.ts';
import { createNotifier, flushOutbox, queueReminders, smtpConfig } from './lib/notify.ts';
import { announceOpenings } from './lib/waitlist.ts';
import { autoInvoice } from './lib/invoices.ts';

const db = openDb();
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

let gcal = null;
try {
  const account = loadServiceAccount();
  if (account) {
    gcal = createGcal({ account });
    console.log(`[gcal] pushing sessions to Google Calendar as ${account.email}`);
  }
} catch (e) {
  console.error('[gcal]', errMsg(e));
}

const notify = createNotifier(db);
console.log(`[notify] email ${smtpConfig() ? 'on' : 'off (set SMTP_* to enable)'}`);
let flushing = false;
const sendNotifications = async () => {
  if (flushing) return;
  flushing = true;
  try { announceOpenings(db, notify); autoInvoice(db, notify); queueReminders(db, notify); await flushOutbox(db); } catch (e) { console.warn('[notify]', errMsg(e)); } finally { flushing = false; }
};

let pushing = false;
const push = async () => {
  if (!gcal || pushing) return;
  pushing = true;
  try { materializeRecurring(db); await pushDirty(db, gcal); } catch (e) { console.warn('[gcal]', errMsg(e)); } finally { pushing = false; }
};

const app = createApp(db, { onChange: () => { push(); sendNotifications(); }, gcalEmail: gcal?.email ?? null, notify });
const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`Tutoring app on http://localhost:${port}`));

// Google Calendar -> app: re-read your calendar so the booking page never offers a time you're busy.
const pull = () => syncCalendar(db).catch((e: unknown) => console.warn('[calendar]', errMsg(e)));
pull();
setInterval(pull, 15 * 60 * 1000).unref();
// App -> Google Calendar: push changes (also triggered right after every change).
setInterval(push, 60 * 1000).unref();
push();
// Notifications: sent right after each change; this also retries failures and sends reminders.
setInterval(sendNotifications, 60 * 1000).unref();

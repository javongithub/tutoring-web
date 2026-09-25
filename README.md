# Tutoring Web - EduPark 

Booking and business manager for a solo tutor. Families request sessions on your site, you approve them, and the app tracks cancellations, a session log with notes, and what you're owed ($30/session by default).

## What it does

**Families (no account; they use private links)**
- **Public booking page (`/`)**: your week with open slots. Other families show only as **Other student**. Classes, clubs, and anything else on your calendar show only as **Busy**. They pick a slot and send a request.
- **Family page (`/family/<secret>`)**: their own sessions by name, your week (everyone else anonymized), and buttons to **ask** to move or cancel, or to request an extra session.
- **Every change needs your approval.** A move request holds the new slot so nobody else takes it. The original session stays booked until you approve.
- **24-hour policy:** a family can still ask for a change inside the window, but a pop-up explains the policy and they must tick *"I understand"* before sending. You see the request flagged **late · policy acknowledged**. An approved late cancel is recorded as late and billed if "charge late cancellations" is on (families are told this in the pop-up).

**You (`/admin`, password login)**
- **Dashboard**: earnings (week / month / unpaid / all-time), requests to approve, past sessions still to log, what's coming up with the plan for each.
- **Calendar**: week view of sessions, requests, cancellations, and your Google Calendar events.
- **Students**: profile, running notes, **"Next time"** plan (updated whenever you log a session), weekly schedules, family link, full history, cancel stats.
- **Tutoring log**: every session with what you covered, notes, next steps, and $. Filter by student, date, or paid status. Export to CSV.
- **Cancellations**: who cancels, how often, late cancels, no-shows, money lost, plus every family change request and your decision.
- **Settings**: rate, session length, booking/cancel notice, late-cancel charging, booking windows, other weekly commitments, Google Calendar sync.

## Run it locally

Requires Node **22.13+** (uses the built-in `node:sqlite`, so there are no native modules to compile).

```bash
npm install
npm run seed            # loads data/seed.local.json if present, else server/seed.example.json
npm run dev             # API on :3001, UI on http://localhost:5173 (admin password: changeme)
npm test
```

Your real client list belongs in `data/seed.local.json`. `data/` is gitignored because **this repo is public**, so never commit client names, emails or notes. Use `npm run seed -- --force` to wipe and reseed.

## Notifications

**Phone alerts (free, instant; the texting alternative).** Real SMS costs money (Twilio has monthly and per-text fees plus carrier registration), so the app uses **ntfy**, a free push-notification app:
1. Install **ntfy** on your phone ([iPhone](https://apps.apple.com/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)).
2. Go to *Admin → Settings → Notifications → Make my link → Save*.
3. In the app, tap **+** and subscribe to the topic shown (the part after `ntfy.sh/`). Keep it secret.
4. Click **Save & send test alert**.

You get a lock-screen alert for new booking requests, cancel/move requests (flagged when late), and withdrawals. Tapping one opens your dashboard.

**Email (free with Gmail).** Turn on 2-Step Verification on your Google account, then create an **App password** at https://myaccount.google.com/apppasswords. On the server, set:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=the-16-char-app-password
```
Restart, then in Settings choose:
- where *you* get emailed
- whether families get emails: request received, confirmed with their family-page link, declined, change approved/declined, and when you cancel or move a session
- optional reminders the evening before each session

Emails come from your own Gmail address, so parents recognize them. Everything is queued and retried, so a mail hiccup never breaks a booking.

## Google Calendar sync (both directions)

**Google Calendar → app (every 15 min).** In Google Calendar, go to *Settings → your calendar → Integrate calendar* and copy the **Secret address in iCal format**. Paste it in *Admin → Settings → Google Calendar sync*.
- Everything on your calendar now blocks booking.
- Events with "tutoring" in the title show families **Other student**. Everything else shows **Busy**.
- The app lists your weekly "… Tutoring" series and imports them as students with one click.

**App → Google Calendar (within seconds).** No OAuth screen needed:
1. In Google Cloud Console, create a project, enable the **Google Calendar API**, create a **service account**, and download its JSON key.
2. Set `GOOGLE_SERVICE_ACCOUNT_JSON` to the key contents (or a file path) and restart.
3. In Google Calendar, go to *Settings → your calendar → Share with specific people* and add the service account's email with **Make changes to events**.
4. In *Admin → Settings*, enter your calendar ID (your Gmail address) and click **Save & push**.
5. Delete your old repeating "… Tutoring" events in Google Calendar. The app owns them now; otherwise you'll see doubles.

**Alternative with no setup:** subscribe to the private feed URL shown in Settings (*Other calendars → From URL*). Google only refreshes these every few hours.

## Deploy (free, 24/7)

This is one Node process with a SQLite file and background sync jobs, so it needs a host with a **persistent disk that stays running**.

| Host | Free? | Works? |
|---|---|---|
| **Google Cloud e2-micro** (us-west1 / us-central1 / us-east1) | Free forever (Always Free) | ✅ Recommended |
| **Oracle Cloud Always Free** VM | Free forever | ✅ More resources, clunkier signup |
| Your own computer + Cloudflare Tunnel | Free | ✅ only while it's on |
| Railway | ~$5/mo | ✅ |
| Fly.io | ~$2–4/mo with a volume | ✅ |
| Render free tier | Free | ❌ sleeps after 15 min, disk is wiped |
| Vercel | Free | ❌ serverless: no disk for SQLite, no background sync |

### Google Cloud e2-micro: one command

1. Go to https://console.cloud.google.com and sign in. Create a project and **link billing**: Google requires a card even for the free tier (you won't be charged for the e2-micro itself).
2. Open **Cloud Shell** (the `>_` icon, top right) and paste:
   ```bash
   BRANCH=main bash <(curl -fsSL https://raw.githubusercontent.com/javongithub/tutoring-web/main/deploy/gcp-create.sh)
   ```
   This creates a free e2-micro VM in `us-west1` with a 30 GB standard disk and firewall rules for HTTPS. It then installs Node, the app and Caddy, generates a strong admin password, and starts everything. It prints:
   - your site address: `https://<your-ip>.sslip.io`, with HTTPS and no domain purchase needed
   - your **admin password** (save it)
3. Load your students, either way:
   - *Settings → Google Calendar*: paste your secret iCal address and click **Import**.
   - Or upload your `seed.local.json` from the VM's SSH window (⚙ → Upload file) and run:
     ```bash
     sudo cp ~/seed.local.json /home/tutor/tutoring-web/data/ && sudo chown tutor: /home/tutor/tutoring-web/data/seed.local.json
     sudo -iu tutor bash -c 'cd tutoring-web && npm run seed'
     ```
4. **Update later:** re-run the same Cloud Shell command. It's safe to repeat and keeps your data and `.env`.

Notes:
- **Don't "Stop" the VM** (reboots are fine). Stopping can change its IP address, and with it the sslip.io address. For a permanent address, point your own domain (or a free DuckDNS name) at the VM and re-run with `DOMAIN=yourname.duckdns.org`.
- Google charges for some external IPv4 addresses. Check *Billing* after a couple of days and set a $1 budget alert so nothing surprises you.
- Backups: nightly snapshot to `data/backups/` (14 days kept). Download one now and then (SSH window → ⚙ → Download file).
- Logs: `sudo journalctl -u tutoring -f`. Edit secrets: `sudo nano /home/tutor/tutoring-web/.env`, then `sudo systemctl restart tutoring`.

A `Dockerfile` is included for Railway/Fly: mount a volume at `/data`.

## How it's built

- **Backend:** Express 5 on Node's built-in SQLite (`server/`). Times are stored as local wall-clock strings (`YYYY-MM-DDTHH:MM`, `TZ_NAME`) so DST never shifts a 4:30pm session.
- **Weekly schedules** generate one session row per week, 10 weeks ahead. Each row keeps its original `slot_key`, so moving or cancelling one week never gets undone by the generator.
- **Privacy:** the public API only ever returns the viewer's own data. Family and booking links are unguessable tokens (the family link can be rotated). Admin uses an HMAC-signed httpOnly cookie. Login and booking are rate-limited.
- **Google Calendar:** a small iCal parser (RRULE/EXDATE/overrides) for pulling, and a service-account JWT for pushing. A SQLite trigger marks changed sessions dirty, and a worker pushes them.
- **Frontend:** React + Vite (`client/`), no UI library.
- **Notifications:** an outbox table drained by a worker (Gmail SMTP via nodemailer, ntfy JSON publish), with retries and once-only reminders.
- **Migrations:** new columns are added automatically on startup (`MIGRATIONS` in `server/db.js`), so updating never needs a manual database step.
- **Tests:** `npm test` covers auth, privacy of the public schedule, booking → approval, approval-gated cancel/move, the 24-hour policy acknowledgement, logging & earnings, iCal parsing, Google push, and notifications.

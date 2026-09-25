# Tutoring Web - EduPark 

Booking and business manager for a solo tutor. Families request sessions on your site, you approve them, and the app tracks cancellations, a session log with notes, and what you're owed ($30/session by default).

## What it does

**Families (no account; they use private links)**
- **Public booking page (`/`)**: your week with open slots. Other families show only as **Other student**. Classes, clubs, and anything else on your calendar show only as **Busy**. They pick a slot and send a request.
- **Family page (`/family/<secret>`)**: their own sessions by name, your week (everyone else anonymized), and buttons to **ask** to move or cancel, or to request an extra session.
- **Every change needs your approval.** A move request holds the new slot so nobody else takes it. The original session stays booked until you approve.

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

### Google Cloud e2-micro walkthrough
1. Create an **e2-micro** VM in `us-west1` with a standard persistent disk (≤30 GB) and Debian/Ubuntu. Allow HTTP/HTTPS.
2. On the VM:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs git caddy
   sudo useradd -m tutor && sudo -iu tutor
   git clone https://github.com/javongithub/tutoring-web && cd tutoring-web
   npm ci && npm run build
   cp .env.example .env && nano .env        # set ADMIN_PASSWORD, SESSION_SECRET
   # copy your data/seed.local.json over (scp), then: npm run seed
   exit
   sudo cp /home/tutor/tutoring-web/deploy/tutoring.service /etc/systemd/system/
   sudo systemctl enable --now tutoring
   ```
3. Point a domain (or a free subdomain from DuckDNS) at the VM's IP, edit `deploy/Caddyfile`, then copy it to `/etc/caddy/Caddyfile` and reload Caddy. HTTPS is automatic.
4. Back up `data/tutoring.db` now and then (e.g. a daily `cp` via cron into a Google Drive-synced folder).

A `Dockerfile` is included for Railway/Fly: mount a volume at `/data`.

## How it's built

- **Backend:** Express 5 on Node's built-in SQLite (`server/`). Times are stored as local wall-clock strings (`YYYY-MM-DDTHH:MM`, `TZ_NAME`) so DST never shifts a 4:30pm session.
- **Weekly schedules** generate one session row per week, 10 weeks ahead. Each row keeps its original `slot_key`, so moving or cancelling one week never gets undone by the generator.
- **Privacy:** the public API only ever returns the viewer's own data. Family and booking links are unguessable tokens (the family link can be rotated). Admin uses an HMAC-signed httpOnly cookie. Login and booking are rate-limited.
- **Google Calendar:** a small iCal parser (RRULE/EXDATE/overrides) for pulling, and a service-account JWT for pushing. A SQLite trigger marks changed sessions dirty, and a worker pushes them.
- **Frontend:** React + Vite (`client/`), no UI library.
- **Tests:** `npm test` covers auth, privacy of the public schedule, booking → approval, approval-gated cancel/move, logging & earnings, iCal parsing, and Google push.

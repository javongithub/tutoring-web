# Security & Threat Model

This app holds personal data about minors (names, schedules, a tutor's notes on how they're doing) and their parents (names, emails, phone numbers), plus payment status. It runs on a single small VM. This document covers what's worth protecting, who might attack it, how, and what stops them. It also lists what's still a known risk.

## Assets

| Asset | Why it matters |
|---|---|
| Student & parent records (names, email, phone, school/grade, notes) | Personal data about children; embarrassing or dangerous if leaked |
| Schedule | Tells a stranger where a specific child is at a specific time |
| Session notes, progress reports | Private academic information |
| Admin session | Full read/write over everything above |
| Secrets (`ADMIN_PASSWORD`, `SESSION_SECRET`, SMTP app password, Google service-account key, Anthropic API key) | Take over the app, send email as the tutor, edit the tutor's calendar, spend API credit |

## Actors

1. **Anonymous internet user / bot:** can reach the public booking page and every public API.
2. **A parent:** holds their own family link, booking links, invoice links, and report links.
3. **Someone who obtains a parent's link:** a forwarded email, a shared screen, browser history on a shared computer.
4. **Someone with the tutor's device or cookie:** a lost phone, a coffee-shop laptop.
5. **Malicious website** visited by the logged-in tutor (CSRF, clickjacking).

## Trust boundaries

```
Browser ──HTTPS (Caddy, Let's Encrypt)──► Express API ──► SQLite file (VM disk)
                                            │
                                            ├──► Gmail SMTP (app password)
                                            ├──► ntfy.sh (push topic)
                                            ├──► Google Calendar (iCal pull / service-account push)
                                            └──► Anthropic API (report drafts)
```

Public routes (`/api/public/*`) trust nothing and authorize by **capability token** (a secret in the URL). Admin routes (`/api/admin/*`) require the signed admin cookie.

## Threats and mitigations

### Information disclosure (the big one)

| Threat | Mitigation |
|---|---|
| Public schedule reveals which child is where | `/api/public/week` returns only `{start, end, label}`. Other families appear as **"Other student"**, and the tutor's own events as **"Busy"**. Names only appear for the *viewer's own* family (checked by family token). Covered by tests: `public week hides names and details`, `family portal … others anonymised`. |
| Guessing someone's family/booking/invoice/report link | Tokens are 18 random bytes from `crypto.randomBytes` (**144 bits**), not sequential IDs. Guessing one isn't feasible. |
| Link leaks through the `Referer` header to other sites | `Referrer-Policy: no-referrer` on every response, plus `<meta name="referrer">`. |
| A family link is forwarded or leaked | The tutor can **rotate** it (Student → Family page → New link); the old link stops working immediately. A leaked link shows only that family's own sessions, invoices and sent reports: never other families, never notes or drafts. |
| Public endpoints over-share | Public responses are built field by field (no `SELECT *` passed through). The invoice page has no email/phone. Report drafts return 404 until sent. |
| Personal data sent to the AI provider | Report prompts contain the student's **first name**, grade, subject and session notes only. No surnames, parent names, emails or phones (enforced in `buildPrompt`, covered by a test). The tutor reviews every draft before anything reaches a parent. |
| Secrets in the public repo | Real client data lives only in `data/` (gitignored). `.env` is gitignored and created `chmod 600` by the deploy script. |

### Spoofing / session attacks

| Threat | Mitigation |
|---|---|
| Password guessing | 10 attempts per IP per 15 minutes. Failed and blocked logins go to the **audit log**, and the Security panel shows the 24-hour count. Production refuses to start with a password under 12 characters. The deploy script generates 16 random characters. |
| Timing attacks on the password/cookie check | Both are compared with `timingSafeEqual` over SHA-256 digests (constant time, length-independent). |
| Stolen admin cookie (XSS, lost device) | Cookie is `HttpOnly` (JS can't read it), `Secure` in production, `SameSite=Lax`, and expires after 30 days. **"Log out everywhere"** bumps a session epoch that's part of every cookie's HMAC, killing all existing sessions, stolen ones included. |
| Forged cookie | HMAC-SHA256 with a 32+ byte `SESSION_SECRET` (enforced in production). |

### Tampering

| Threat | Mitigation |
|---|---|
| CSRF: a malicious site makes the tutor's browser cancel sessions | `SameSite=Lax` cookie, **and** every non-GET `/api` request must be `application/json` or carry `X-Requested-With: tutoring-web`. Browsers can only send those cross-site after a CORS preflight, which this API never approves. Test: a form-encoded POST with a valid cookie gets `415`. |
| Clickjacking | `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'`. |
| SQL injection | Every query uses bound parameters (`?`). The few template-built SQL strings interpolate only code constants (table names, a fixed `BILLABLE` clause, placeholder lists). Audited with `grep 'prepare(`.*\${'`. |
| XSS | React escapes all output, and there's no `dangerouslySetInnerHTML`/`innerHTML`. **Content-Security-Policy** allows only same-origin scripts and styles (no inline script, no `eval`), so an injected script wouldn't run even if an escaping bug slipped in. Verified by loading every page of the production build with zero CSP violations. Emails are plain text. |
| Families changing things they shouldn't | Families can only *request* changes; every cancel/move needs tutor approval. Server-side checks: one open request per session; the requested slot must be genuinely open (re-validated at approval, with conflicts reported); inside the 24-hour window they must acknowledge the policy (enforced server-side, not just in the UI). |
| Booking spam / fake requests | Honeypot field, rate limits (8 booking requests/hour/IP, 5 waitlist signups/hour/IP), and every booking needs tutor approval anyway. |

### Repudiation

| Threat | Mitigation |
|---|---|
| "I never cancelled that" / "who changed this?" | The **audit log** records every admin write (method, path, status, IP, time) and every login. Family change requests keep their reason, request time, policy acknowledgement and the tutor's decision. |

### Denial of service

| Threat | Mitigation |
|---|---|
| Request floods | Rate limits on login and public writes. JSON bodies are capped at 100 KB. Range queries are capped at 62 days. Caddy absorbs TLS. This is a single small VM, so a determined DDoS would take it down. That's accepted for a tutoring site (see residual risks). |
| Slow or failing email/push/calendar/AI providers blocking bookings | Notifications go through an **outbox** drained by a background worker with retries, and calendar sync runs on a timer. A provider outage never fails a booking. AI calls are tutor-initiated only. |

## Residual risks (accepted, with reasons)

- **Single admin password, no 2FA.** There's one user and the attack surface is small. Mitigated by rate limiting, audit logging and "log out everywhere". Next step: TOTP.
- **Capability links are bearer secrets.** Anyone with a family link can act as that family (request changes, not make them). This is the trade-off for parents not needing accounts. Mitigated by the 144-bit tokens, rotation, and tutor approval on every change.
- **No encryption at rest beyond the VM disk.** Google encrypts persistent disks by default. Backups in `data/backups/` inherit the VM's protection. Downloaded backups are the user's responsibility.
- **The ntfy topic is public-by-knowledge.** Anyone who learns the topic name can read alerts. Alerts contain first names and times only, and the topic is random. Self-hosting ntfy or using access tokens would close this.
- **Availability.** One VM, no redundancy. Nightly backups limit data loss to at most a day.

## Verifying

```bash
npm test                        # includes privacy, CSRF, audit and session-revocation tests
npm audit --omit=dev            # 0 known vulnerabilities at time of writing
curl -sI https://<site>/ | grep -i -E 'content-security|strict-transport|referrer|frame'
```

## Reporting a problem

Please email the maintainer privately rather than opening a public issue.

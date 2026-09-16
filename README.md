# EduMemo — Web-Based Memo Distribution System

A complete, working memo distribution platform for tertiary institutions, built with
**Node.js, Express, SQLite, and vanilla HTML/CSS/JavaScript** (no PHP, no MySQL, no
frontend framework). Staff and administrators create official memos, target the right
students by faculty/department/programme/level/study mode/course, attach documents,
publish, and the system notifies recipients in-app, by web push, and immediately by
email.

---

## 1. Requirements

- **Node.js 18+** (check with `node -v`)
- npm (comes with Node.js)
- No PHP, MySQL, MongoDB, or XAMPP needed — everything runs on Node.js with a local
  SQLite file.

## 2. Installation

```bash
cd edumemo
npm install
```

## 3. Environment configuration

Copy the example environment file and edit it:

```bash
cp .env.example .env
```

Open `.env` and review the values. At minimum for local development you can leave
`SMTP_*` and `VAPID_*` blank — see sections 11 and 12 below for what happens when they're
not configured.

Key variables:

| Variable | Purpose |
|---|---|
| `PORT` | Port the server listens on (default 3000) |
| `SESSION_SECRET` | Long random string used to sign session cookies — **change this** |
| `DATABASE_PATH` | Where the SQLite file lives |
| `INSTITUTION_NAME` / `INSTITUTION_SHORT_NAME` | Displayed across the app (see section 5) |
| `SMTP_*` | Outgoing email configuration (section 11) |
| `VAPID_*` | Web Push keys (section 12) |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Used only by the seed script (section 10) |

`.env` is listed in `.gitignore` and is never committed. No institutional credentials
are hard-coded anywhere in the source.

## 4. SQLite setup & database initialization

The schema is applied automatically every time the server starts (`database/init.js`
runs `database/schema.sql`, which uses `CREATE TABLE IF NOT EXISTS`, so it's always
safe to re-run). You don't need to run anything manually, but you can if you want to
initialize the database without starting the server:

```bash
npm run init-db
```

This creates `database/database.sqlite` (path configurable via `DATABASE_PATH`).

## 5. Branding

The institution's name comes from `INSTITUTION_NAME` / `INSTITUTION_SHORT_NAME` in
`.env` — edit those two lines and every page updates automatically (no template
edits needed). The logo lives at `public/images/logo.png`; replace that file with
the institution's real logo (any raster image works; it's referenced by filename
only, not by content).

## 6. Seed data (recommended before first use)

```bash
npm run seed
```

This creates sample faculties, departments, programmes, levels, study modes, courses,
memo categories, and the following **demo accounts**:

| Role | Email | Password | Notes |
|---|---|---|---|
| Administrator | `admin@example.edu` (or `SEED_ADMIN_EMAIL`) | `ChangeMe123!` (or `SEED_ADMIN_PASSWORD`) | Full system access |
| Staff — teaching (approved) | `staff.demo@example.edu` | `Password123!` | Can publish memos immediately |
| Staff — teaching (pending) | `staff.pending@example.edu` | `Password123!` | Demonstrates the approval workflow — cannot log in until an admin approves |
| Staff — non-teaching | (register one from `/register-staff.html`) | — | Receive-only: also needs admin approval before the first login; can never create or send memos |
| Students | `csc.2023.001@example.edu`, `csc.2022.014@example.edu`, `eee.2023.007@example.edu`, `eee.2021.033@example.edu`, `eng.2023.019@example.edu` | `Password123!` | Spread across faculties/levels/courses for testing targeted memos |

**Change or remove these credentials before any production deployment.** The seed
script is additive and safe to re-run — it skips accounts/records that already exist.

Core functionality (registration, login, memo creation, etc.) does **not** depend on
seed data; you can also start from a completely empty database and register a real
first administrator (see section 9).

## 7. Starting the server

```bash
npm start
```

or, for development with auto-restart on file changes:

```bash
npm run dev
```

## 8. Accessing the website

Open **http://localhost:3000** in a browser (redirects to the login page). On a phone
or another device on the same network, use your machine's LAN IP instead of
`localhost`, e.g. `http://192.168.1.20:3000`.

## 9. Creating the first administrator (without seed data)

If you don't want to use the seed script, create the first administrator directly
with a short Node script (run once):

```bash
node -e "
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./database/db');
require('./database/init')();
const email = 'admin@yourinstitution.edu';
const password = 'ChangeThisPassword123!';
const hash = bcrypt.hashSync(password, 12);
const result = db.prepare(\`INSERT INTO users (role, email, password_hash, first_name, last_name, status, email_verified) VALUES ('administrator', ?, ?, 'System', 'Administrator', 'active', 1)\`).run(email, hash);
db.prepare('INSERT INTO administrators (user_id, super_admin) VALUES (?, 1)').run(result.lastInsertRowid);
console.log('Administrator created:', email);
"
```

Once logged in, this administrator can create additional administrator accounts from
**Administrators** in the sidebar — there is no public administrator registration
route, by design.

## 10. Demo/seed credentials

See section 6. They are clearly separated from application logic (only ever inserted
by `database/seed.js`, which you run explicitly) and are safe to skip entirely.

## 11. Configuring email (SMTP)

Set these in `.env`:

```
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-username
SMTP_PASSWORD=your-smtp-password
SMTP_FROM_EMAIL=noreply@yourinstitution.edu
SMTP_FROM_NAME=Your Institution
```

**If these are left blank**, EduMemo does not fail — it runs in development mode:
every email (welcome, password reset, staff approval, new-memo notifications) is
logged to the server console instead of being sent, and the forgot-password API
response includes a `devResetUrl` field with a clickable link so you can test the
full flow without a mail server. The frontend surfaces this link directly on the
forgot-password page when present.

**Email verification**: new registrations start unverified and are emailed a
verification link (valid 48 hours). The account can sign in once the link is
clicked; the welcome email is sent right after verification. The verification
page is mobile-responsive, so the same link works when opened on a phone.

**Memo delivery**: when a memo is published, every registered user it targets
receives the memo **by email immediately** — no opt-in or per-user email setting
is required. Web push is still an opt-in extra on supported devices.

## 12. Configuring Web Push

Generate a VAPID key pair once:

```bash
npx web-push generate-vapid-keys
```

Copy the output into `.env`:

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@yourinstitution.edu
```

Restart the server. Users can then enable push notifications from **Settings** (or
during registration); the browser will prompt for notification permission, and the
subscription is stored in `push_subscriptions`. If VAPID keys are not configured, the
subscribe/unsubscribe endpoints still work, but no push payloads are actually sent
(the settings page tells the user push isn't configured yet).

### Web Push — how it reaches a phone, even when EduMemo is "closed"

- **Who gets a push**: a memo is delivered by web push only to recipients who have
  actually completed a browser subscription on at least one device (`push_subscriptions`
  row). The `enablePush` choice during registration records the *preference*; the
  actual permission prompt happens the first time the user enables the toggle in
  **Settings** (or clicks the one-time banner shown on the dashboard after login).
- **Phone experience**: on **Android Chrome**, after enabling push and choosing
  *Add to Home screen* (which installs EduMemo as a PWA), Chrome keeps the push
  connection alive, so new-memo notifications appear even when the site is closed.
  The service worker (`public/service-worker.js`) displays the alert and routes taps
  to the memo. **iPhone/iPad (Safari) does not support Web Push** — those devices are
  told so in the UI and receive the memo by email instead.
- **Important**: web push requires the follow-up permission granting on each new
  browser/device. Disabling it in Settings only unsubscribes the current device.

### Forgot / reset password

- The login page links to `/forgot-password.html`. Entering a registered email creates
  a single-use reset token (stored in `password_reset_tokens`, valid **1 hour**), and
  the existing email system mails a link to `/reset-password.html?token=...`.
- Requesting a new link invalidates any earlier unused link for the same account.
- The reset page is a normal mobile-responsive page, so the link can be opened on a
  phone; the new password is hashed with bcrypt and the user is then able to log in.
- Unauthenticated abuse is throttled by `passwordResetLimiter` (8 requests / 15 min).

### Deploying to Railway (production checklist)

1. **Start command**: `npm start`; Railway supplies `PORT` automatically.
2. **Persistence**: attach a **Volume** to the service — the app auto-detects
   `RAILWAY_VOLUME_MOUNT_PATH` and stores the SQLite database + uploads there so
   accounts and attachments survive redeploys (see the startup banner).
3. **Environment variables** (Railway → Variables):
   ```
   NODE_ENV=production
   BASE_URL=https://<your-app>.up.railway.app   # used inside emailed links
   SESSION_SECRET=<long random string>
   SMTP_HOST=... SMTP_PORT=587 SMTP_SECURE=false SMTP_USER=... SMTP_PASSWORD=... SMTP_FROM_EMAIL=...
   SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=...  # first boot only
   VAPID_PUBLIC_KEY=<from npx web-push generate-vapid-keys>
   VAPID_PRIVATE_KEY=<...>
   VAPID_SUBJECT=mailto:admin@yourinstitution.edu
   ```
   The startup banner prints whether SMTP and Web Push (VAPID) are configured, plus
   warnings if the DB isn't persistent, if VAPID keys are missing, or if `BASE_URL`
   is unset.
4. **HTTPS**: Railway's default domain already serves HTTPS, which the service worker
   and Web Push require (both are served at the site root, `/service-worker.js`).
5. **Email links**: with `BASE_URL` set, password-reset / verification / new-memo
   emails always link to your real domain, which also avoids spam-filter flags.

## 13. Project structure

```
edumemo/
├── server.js                 # Express app entry point
├── package.json
├── .env.example               # documents required config keys (no real secrets)
├── database/
│   ├── schema.sql              # full normalized SQLite schema
│   ├── db.js                   # shared better-sqlite3 connection
│   ├── init.js                 # applies schema.sql (idempotent)
│   └── seed.js                 # sample data + demo accounts
├── routes/                     # Express route definitions (thin)
├── controllers/                # request handling + business logic
├── middleware/                 # auth, CSRF, upload, rate limiting, error handling
├── services/                   # email, web push, notification fan-out, recipient targeting
├── utils/                      # audit logging, token generation
└── public/                     # static frontend (HTML/CSS/vanilla JS)
    ├── css/styles.css
    ├── js/{api,app,push}.js
    ├── images/logo.png
    ├── uploads/                 # memo attachments (created automatically)
    ├── service-worker.js        # Web Push handling
    ├── login.html, register-*.html, verify-email.html, forgot/reset-password.html
    ├── memo.html                 # shared memo detail/read view
    ├── student/                  # student dashboard + settings
    ├── staff/                    # staff dashboard, create/edit memo, memos list, settings
    └── admin/                    # admin dashboard, memo records, users, academic structure,
                                   # administrators, audit logs, system settings
```

## 14. Testing

There is no automated test suite (out of scope for this build), but the system has
been manually verified end-to-end, including:

- Student registration → welcome email → login (no email verification required)
- Staff registration → welcome email → **administrator approval** → login (no email
  verification required; every new staff account starts as `pending_approval`)
- Staff approval workflow: unapproved staff cannot log in at all, and — once approved —
  publishing memos stays reserved for **teaching** staff (non-teaching staff can never
  publish because they are receive-only)
- **Receive-only non-teaching staff**: they can read the memos addressed to them,
  but every create/edit/publish/resend/archive/delete memo endpoint returns 403.
  The rule is enforced by `requireMemoPublisher` in the route layer *and* repeated
  in `memoController`, so the UI is never the only guard.
- Draft creation with file attachment → edit → preview → publish
- Combinable recipient targeting (e.g. **Course = GST 102 AND Level = 100 Level**)
  resolving to exactly the matching students, verified against seed data
- Access control: non-recipients cannot open or download a memo they weren't targeted for
- Read-state tracking (marking a memo read on open, visible to sender/admin)
- In-app, email, and web-push notification fan-out on publish
- Institution-wide broadcast restricted to administrators, with mandatory
  "SEND TO ENTIRE INSTITUTION?" confirmation before sending
- Admin-side memo records, staff/student user management, audit logging,
  academic-structure CRUD (faculties/departments/programmes/levels/study
  modes/courses/categories)
- **Data durability**: the SQLite file is confirmed valid (verified with the
  `file` command) and a freshly-started server process correctly reloads all
  previously saved data from disk

To exercise these yourself, run `npm run seed`, then `npm start`, and log in with the
demo accounts in section 6.

`npm run check:staff-permissions` verifies the staff rules above automatically: it
boots its own server on port 3211 against a **throwaway database** (the real
`database/database.sqlite` is never touched), asserts that every newly registered
staff account (teaching and non-teaching) starts as `pending_approval` and cannot
log in until an administrator approves it, that every memo-writing endpoint refuses
non-teaching staff, that memos targeted at them still arrive once approved, and
that approved teaching staff can create and publish memos. No seed data or
already-running server is required.

`npm run check:notifications` does the same for notification delivery, on port 3213:
it publishes an institution-wide memo to two throwaway students — one of them
subscribed to a push endpoint that cannot be reached — and asserts that both
recipients get an in-app notification and a delivery record for the memo (so one
dead device can never silence the rest), that an email which was never handed to a
mail server is logged as `skipped` rather than `sent`, that the failed push carries
its reason, and that the unreachable device's subscription is kept.

When staff or students report that they did **not** get the memo email or push
alert, run the diagnostics against the same database/environment the app uses:

```bash
npm run diag:delivery                                   # what was actually delivered
node test-smtp-send.js you@example.com                  # real SMTP send + server reply
npm run test:push                                       # real push to the stored device
```

`diag:delivery` prints the delivery tables (recipients, email rows with their
errors, push rows with their reasons), confirms the VAPID public/private key pair
actually matches, and checks that the SMTP credentials are accepted — which is
enough to tell "the server never sent it" apart from "the mailbox filtered it".

## 15. Troubleshooting

**`npm install` fails with node-gyp / MSBuild / Visual Studio / Python errors**
(mainly on Windows): this should no longer happen. Every dependency in this
project — including the database driver — is pure JavaScript or WebAssembly.
Nothing needs to be compiled, on any operating system. If you still see a
native-build error, run `npm ls` and check which package is at the top of the
error trace; it should not be `sql.js`, `bcryptjs`, `multer`, or anything else
listed in `package.json`. If it's a dependency of a dependency, try deleting
`node_modules` and `package-lock.json` and running `npm install` again with a
clean cache (`npm cache clean --force`).

**Nothing happens when I click "Run" in VS Code**: this is a plain Node.js
server, not a VS Code debug target — there's no `.vscode/launch.json` telling
the Run button what to start. Open a terminal inside VS Code (`` Ctrl+` ``)
and run `npm start` there, then open `http://localhost:3000` in a browser.

**`EADDRINUSE` on startup**: something else is already using port 3000.
Change `PORT` in `.env` or stop the other process.

**"Students and staff say the memo email never arrived"**: check the delivery
report first — `npm run diag:delivery` (or Admin ▸ Reports, which shows sent /
failed / skipped counts). Mail that was never handed to a mail server is now
recorded as `skipped` instead of `sent`, so the report cannot look healthy while
nothing is going out. Then, in order of likelihood:

1. `SMTP (email) configured: NO` in the startup banner or `emailConfigured: false`
   in the report → the deployment is missing `SMTP_HOST` / `SMTP_USER` /
   `SMTP_PASSWORD` / `SMTP_FROM_EMAIL`. Until they are set, nothing is sent.
2. Rows with `failed` and a 4xx/5xx reason → read the reason. `421/454 … try again
   later` is Gmail throttling and is now retried automatically with a backing-off
   delay; `535 … authentication` means the Gmail App Password was revoked (make a
   new one — the 16-character key, no spaces); `550 5.4.5 Daily user sending limit
   exceeded` means a normal Gmail account's daily cap was reached, which a
   whole-institution memo can hit instantly — use a transactional provider
   (Brevo/SendGrid/Mailgun/Resend) for real bulk sending.
3. Everything says `sent` but the inbox is empty → check the recipient's **Spam**
   folder and mark one message "not spam". Memo mail is sent from a Gmail address
   with a green button, which some filters treat as bulk mail.

**"Web push notifications stopped arriving"**: the server only knows about a
device while a row for it exists in `push_subscriptions`, and that table is lost
whenever the host redeploys/replaces the database (which is what `Persistent
storage detected: NO` in the startup banner warns about — on a host with an
ephemeral disk, set `DATABASE_PATH` to a mounted volume/disk). The web client now
re-registers each device automatically on every page load, so push recovers by
itself once the app is reloaded; users can also re-enable it from Settings ▸ Web
push notifications. Use `npm run test:push` to send a live push to every stored
device and see exactly what the push service (FCM) replies — a `403` means the
VAPID key pair changed after the device subscribed (the subscription is kept, not
deleted), and `404/410` means the endpoint itself is gone and the user must
re-enable push on that device.


---

## Notes on design decisions

- **Database driver**: SQLite is accessed through `sql.js`, a WebAssembly build
  of SQLite, rather than a native addon like `better-sqlite3`. This means
  `npm install` never needs a C++ compiler on any platform. `database/db.js`
  wraps it in a small adapter exposing the same `prepare(sql).run/get/all()`,
  `exec()`, and `transaction()` shape used throughout the codebase. The
  database is kept in memory and explicitly serialized to
  `database/database.sqlite` after each write (or once per transaction, not
  mid-transaction, since exporting mid-transaction was found to corrupt sql.js's
  internal transaction state).
- **Sessions** are stored in the same sql.js-backed database (`middleware/sessionStore.js`,
  `sessions` table) rather than via `connect-sqlite3`, which would have pulled
  the native `sqlite3` package back in.
- **Recipient targeting** stores one set of filter rules per memo
  (`memo_target_rules`) and a single row per (memo, recipient) in
  `memo_recipients` — the memo body itself is never duplicated per recipient.
- **Staff broadcast permission**: by default only administrators can select "Entire
  Institution". The `users.can_broadcast_institution` column and
  `/api/admin/staff/:id/broadcast-permission` endpoint exist so an administrator
  can extend that privilege to specific staff in the future without a schema change,
  per the original specification — the current UI doesn't expose a toggle for it yet,
  but the data model and endpoint are ready.
- **Levels and study modes are fully configurable** from Academic Structure (no
  hard-coded ND/HND/100-500 Level assumptions) — the seed data uses "100–400 Level"
  purely as an example.
- **CSRF protection** uses a lightweight custom double-submit-token implementation
  (`middleware/csrf.js`) rather than the archived `csurf` package.
- **File uploads** are validated by both extension and MIME type, renamed to random
  filenames on disk (no path traversal, no trusting user-supplied names), and capped
  at 15MB.
#   e d u m e m o  
 
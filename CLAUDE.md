# Rolevance API — Claude Instructions

Read the parent CLAUDE.md at `/srv/Extensions/CLAUDE.md` first. Everything there applies here too. This file adds the API-specific details.

---

## Stack
- **Language:** TypeScript (strict mode, compiled with `tsc`)
- **Framework:** Express 5
- **Database:** SQLite via `better-sqlite3` (fully synchronous — no `await` on DB calls)
- **AI:** Groq SDK — `llama-3.3-70b-versatile` for scoring and analysis, `llama-3.1-8b-instant` for profile parsing
- **Process manager:** PM2 (config in `ecosystem.config.js`)
- **Reverse proxy:** Nginx (config in `nginx.conf`)

---

## File map — what every file does

```
src/index.ts
  → Entry point. Initialises the database, starts the log cleanup schedule,
    starts the Express server, handles graceful shutdown on SIGTERM/SIGINT.

src/api/server.ts
  → Wires everything together. Sets up Express middleware (CORS, JSON parsing),
    registers all routes, handles the /health endpoint and 404s.
    The webhook route MUST stay before express.json() — do not reorder.

src/db/database.ts
  → Everything database-related lives here. Table creation, migrations,
    all query functions, tier logic, panel gate logic, usage tracking.
    This is the ONLY file allowed to write SQL. Never put queries in routes.

src/middleware/auth.ts
  → requireDevice middleware. Validates X-Client-Secret and X-Device-ID on
    every request. Creates the device record if it's the first time we've
    seen this device ID. Attaches deviceId to req for downstream handlers.

src/middleware/rateLimit.ts
  → checkRateLimit middleware. Checks daily usage against per-tier limits
    and blocks the request with 429 if exceeded. Increments the counter
    after allowing the request through.

src/routes/scoreRouter.ts    → POST /api/score/batch
src/routes/analyzeRouter.ts  → POST /api/analyze/job
src/routes/profileRouter.ts  → POST /api/profile/parse
src/routes/panelRouter.ts    → POST /api/panel/open
src/routes/subscriptionRouter.ts → GET /api/subscription/status, POST /api/subscription/restore
src/routes/deviceRouter.ts   → POST /api/device/email
src/routes/webhookRouter.ts  → POST /webhook/lemonsqueezy
src/routes/adminRouter.ts    → All /admin/* endpoints

src/services/groqClient.ts
  → All Groq AI calls. batchScoreJobs(), analyzeJob(), parseProfile().
    Includes retry logic for rate limits and transient failures.
    Includes GroqParseError for when the AI returns malformed JSON.
```

---

## Database rules — strictly follow these

- **All SQL goes in `src/db/database.ts` only** — routes call exported functions, never raw SQL
- **better-sqlite3 is synchronous** — `db.prepare().get()` and `.run()` return immediately, no `await`
- **Migrations** are at the bottom of `initDatabase()` — new columns go there using `ALTER TABLE`, wrapped in try/catch so they silently skip if the column already exists
- **The database file** is `data/rolevance.db` — created automatically on first run
- **Never drop or rename tables** — add columns via migration only

---

## Tier and rate limit logic

Tier priority order (highest wins):
1. `tier_override = 'pro'` on the device → always Pro (admin grant)
2. `subscriptions_enabled = false` in settings → everyone is Pro (testing mode)
3. Within 5 days of `trial_started_at` → trial (full access)
4. `tier = 'pro'` AND subscription is `active` or `past_due` or `cancelled` with future `ends_at` → Pro
5. Everything else → free

Rate limits per type:
- `batch` (scoring): free = 30/day, pro/trial = unlimited
- `analyze` (deep AI): free = 0 (locked completely), pro/trial = unlimited
- `profile` (parse): free = 1/day, pro/trial = unlimited
- `panel` (opens): free = 5/day (same job reopened = free), pro/trial = unlimited

---

## API auth flow

Every request (except `/health`, `/admin/*`, `/webhook/*`) must have:
- `X-Client-Secret: <value matching process.env.CLIENT_SECRET>`
- `X-Device-ID: <valid UUID v4>`

The extension sends these automatically. The `requireDevice` middleware in `auth.ts` validates them and calls `upsertDevice()` to register new devices.

---

## Commands

```bash
npm run dev      # Development with hot reload (nodemon + ts-node)
npm run build    # Compile TypeScript → dist/
npm start        # Build + run (for production testing)

# Production only:
pm2 restart rolevance-api   # Restart after a build
pm2 logs rolevance-api      # Watch live logs
pm2 status                  # Check process health
```

---

## After every change — always do this

1. Run `npm run build` — fix any TypeScript errors before declaring done
2. If in production: run `pm2 restart rolevance-api` after a successful build
3. If the change adds a new endpoint: check that `requireDevice` and `checkRateLimit` are applied in `server.ts`
4. If the change touches tier logic: check both `database.ts` and `rateLimit.ts` are consistent

---

## Things that must never be broken

- **Fail-open in panelRouter.ts** — if `recordPanelOpen()` throws, the catch block returns `allowed: true`. Users must never be blocked from their panel by a server error.
- **Webhook raw body** — `webhookRouter` is registered with `express.raw()` BEFORE `express.json()` in `server.ts`. The raw Buffer is needed for HMAC signature verification. If this order changes, all payment webhooks will fail silently.
- **`tierForStatus('cancelled') = 'pro'`** — a cancelled subscription stays Pro until `subscription_ends_at`. Changing this to 'free' would cut off users who cancelled but still have paid time remaining.
- **Trial = 5 days** — `TRIAL_DAYS = 5` in `database.ts`. The `adminRouter.ts` SQL also checks `+5 days`. Both must always match.
- **Graceful shutdown** — `index.ts` closes the SQLite database before `process.exit()`. This must stay or in-flight writes can be lost on PM2 restart.

---

## Known issues (fix these when the time comes, don't work around them)

- `CLIENT_SECRET` is hardcoded in `rolevance-extension/background/service-worker.js`. Anyone can unpack the extension and read it. This needs a proper solution — discuss options before touching it.
- The admin panel at `/admin-panel` has no rate limiting on failed login attempts beyond the in-memory brute force guard in `adminRouter.ts`. This resets on server restart.

import Database         from 'better-sqlite3'
import type { Statement } from 'better-sqlite3'
import path             from 'path'
import fs               from 'fs'
import { randomUUID }   from 'crypto'
import { TRIAL_DAYS, PANEL_LIMITS, PAST_DUE_GRACE_DAYS, UsageType } from '../config/limits'

const DATA_DIR = path.join(process.cwd(), 'data')
const DB_PATH  = path.join(DATA_DIR, 'rolevance.db')
fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(DB_PATH)

export function initDatabase(): void {
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // ── devices ───────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id         TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // ── usage ─────────────────────────────────────────────────────────────────
  // jobs_scored counts individual job cards scored (not API batch calls).
  // analyze_calls and profile_calls remain 1:1 with API calls.
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      device_id     TEXT NOT NULL REFERENCES devices(id),
      date          TEXT NOT NULL DEFAULT (date('now')),
      jobs_scored   INTEGER NOT NULL DEFAULT 0,
      analyze_calls INTEGER NOT NULL DEFAULT 0,
      profile_calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (device_id, date)
    )
  `)

  // ── panel_opens ────────────────────────────────────────────────────────────
  // Composite PK (device_id, date, job_id) is the uniqueness constraint —
  // INSERT OR IGNORE on duplicate is a silent no-op so same job re-opened
  // on the same day costs only one slot.
  db.exec(`
    CREATE TABLE IF NOT EXISTS panel_opens (
      device_id TEXT NOT NULL,
      date      TEXT NOT NULL DEFAULT (date('now')),
      job_id    TEXT NOT NULL,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (device_id, date, job_id)
    )
  `)

  // ── request_logs ──────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id         TEXT PRIMARY KEY,
      device_id  TEXT,
      endpoint   TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      status     INTEGER NOT NULL,
      error      TEXT    DEFAULT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // ── settings ──────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  // ── indexes ───────────────────────────────────────────────────────────────
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_date    ON usage (date)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_created  ON request_logs (created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_device   ON request_logs (device_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_status   ON request_logs (status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_panel_device  ON panel_opens (device_id, date)`)
  // NOTE: idx_devices_email is created AFTER the migrations below — the `email`
  // column doesn't exist on a fresh install until the ALTER TABLE runs.

  // ── migrations ────────────────────────────────────────────────────────────
  const deviceMigrations = [
    `ALTER TABLE devices ADD COLUMN email                TEXT DEFAULT NULL`,
    `ALTER TABLE devices ADD COLUMN tier                 TEXT DEFAULT 'free'`,
    `ALTER TABLE devices ADD COLUMN tier_override        TEXT DEFAULT NULL`,
    `ALTER TABLE devices ADD COLUMN subscription_id      TEXT DEFAULT NULL`,
    `ALTER TABLE devices ADD COLUMN subscription_status  TEXT DEFAULT NULL`,
    `ALTER TABLE devices ADD COLUMN subscription_ends_at TEXT DEFAULT NULL`,
    `ALTER TABLE devices ADD COLUMN trial_started_at     TEXT DEFAULT NULL`,
    `ALTER TABLE devices ADD COLUMN past_due_at          TEXT DEFAULT NULL`,
  ]
  for (const sql of deviceMigrations) {
    try { db.exec(sql) } catch { /* column already exists */ }
  }

  // Rename batch_calls → jobs_scored on existing databases.
  // Fresh installs: CREATE TABLE above already uses jobs_scored, so this
  // ALTER fails silently because there's no batch_calls column.
  // Existing installs: this rename preserves all historical data (note that
  // legacy values represent batch counts, not job counts — semantically
  // misleading but only affects pre-migration analytics rows).
  try {
    db.exec(`ALTER TABLE usage RENAME COLUMN batch_calls TO jobs_scored`)
  } catch { /* already renamed or column never existed */ }

  // Sanity check — fail loudly at startup if jobs_scored isn't present,
  // rather than silently breaking every INSERT downstream.
  try {
    db.prepare(`SELECT jobs_scored FROM usage LIMIT 0`).all()
  } catch (err) {
    throw new Error(
      `[Startup] usage.jobs_scored column missing — schema migration failed. ` +
      `Run manually: ALTER TABLE usage RENAME COLUMN batch_calls TO jobs_scored`
    )
  }

  // Index on devices.email — must come AFTER the migration loop, since
  // `email` doesn't exist on a fresh DB until the ALTER TABLE runs above.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_email ON devices (email)`)

  // ── seed default settings ─────────────────────────────────────────────────
  // subscriptions_enabled defaults to TRUE — we launch with subscriptions on.
  // Free users must buy Pro or activate a trial to get full access.
  const subRow = db.prepare(`SELECT value FROM settings WHERE key = 'subscriptions_enabled'`).get()
  if (!subRow) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('subscriptions_enabled', 'true')`).run()
  }

  _initStatements()
  console.log('Database initialized')
}

// ── Prepared statement guard ──────────────────────────────────────────────────
// Throws clearly if initDatabase() was not called before first use.
// Replaces silent optional-chaining (?.) no-ops.
type Stmt = Statement<unknown[]>
function _stmt(s: Stmt | null, label: string): Stmt {
  if (!s) throw new Error(`DB not initialized — statement "${label}" is null. Call initDatabase() first.`)
  return s
}

let stmtUpsertDevice: Stmt | null = null
let stmtGetUsage:     Stmt | null = null
let stmtIncrScore:    Stmt | null = null
let stmtIncrAnalyze:  Stmt | null = null
let stmtIncrProfile:  Stmt | null = null
let stmtInsertLog:    Stmt | null = null
let stmtPanelCount:   Stmt | null = null
let stmtPanelExists:  Stmt | null = null
let stmtPanelInsert:  Stmt | null = null

function _initStatements(): void {
  stmtUpsertDevice = db.prepare(`
    INSERT INTO devices (id) VALUES (?)
    ON CONFLICT(id) DO UPDATE SET last_seen = datetime('now')
  `)

  stmtGetUsage = db.prepare(`
    SELECT jobs_scored, analyze_calls, profile_calls
    FROM   usage
    WHERE  device_id = ? AND date = date('now')
  `)

  // Each increment statement takes (device_id, count). The ON CONFLICT path
  // adds the same `excluded.<col>` value, so a fresh row inserts `count`
  // and an existing row adds `count` to whatever's already there.
  stmtIncrScore = db.prepare(`
    INSERT INTO usage (device_id, jobs_scored) VALUES (?, ?)
    ON CONFLICT(device_id, date) DO UPDATE SET jobs_scored = jobs_scored + excluded.jobs_scored
  `)

  stmtIncrAnalyze = db.prepare(`
    INSERT INTO usage (device_id, analyze_calls) VALUES (?, ?)
    ON CONFLICT(device_id, date) DO UPDATE SET analyze_calls = analyze_calls + excluded.analyze_calls
  `)

  stmtIncrProfile = db.prepare(`
    INSERT INTO usage (device_id, profile_calls) VALUES (?, ?)
    ON CONFLICT(device_id, date) DO UPDATE SET profile_calls = profile_calls + excluded.profile_calls
  `)

  stmtInsertLog = db.prepare(`
    INSERT INTO request_logs (id, device_id, endpoint, latency_ms, status, error)
    VALUES (@id, @deviceId, @endpoint, @latencyMs, @status, @error)
  `)

  stmtPanelCount = db.prepare(`
    SELECT COUNT(*) as c FROM panel_opens
    WHERE device_id = ? AND date = date('now')
  `)

  stmtPanelExists = db.prepare(`
    SELECT 1 FROM panel_opens
    WHERE device_id = ? AND date = date('now') AND job_id = ?
  `)

  stmtPanelInsert = db.prepare(`
    INSERT OR IGNORE INTO panel_opens (device_id, job_id) VALUES (?, ?)
  `)
}

// ── Device helpers ────────────────────────────────────────────────────────────

export function upsertDevice(id: string): void {
  _stmt(stmtUpsertDevice, 'upsertDevice').run(id)
}

export interface UsageRow {
  jobs_scored:   number
  analyze_calls: number
  profile_calls: number
}

export function getUsageToday(deviceId: string): UsageRow {
  const row = _stmt(stmtGetUsage, 'getUsage').get(deviceId) as UsageRow | undefined
  return row ?? { jobs_scored: 0, analyze_calls: 0, profile_calls: 0 }
}

// Re-export so callers don't have to import from two places.
export type { UsageType } from '../config/limits'
import type { UsageType as _UsageType } from '../config/limits'

// `by` defaults to 1 — most callers (analyze, profile) increment by one per
// API call. Score is special: one /api/score/batch call scores N jobs, so
// the route handler passes by = jobs.length.
export function incrementUsage(deviceId: string, type: _UsageType, by: number = 1): void {
  if (by < 1) return
  if (type === 'score')   _stmt(stmtIncrScore,   'incrScore').run(deviceId, by)
  if (type === 'analyze') _stmt(stmtIncrAnalyze, 'incrAnalyze').run(deviceId, by)
  if (type === 'profile') _stmt(stmtIncrProfile, 'incrProfile').run(deviceId, by)
}

// ── Atomic limit-check + increment ───────────────────────────────────────────
// Used by rateLimit.ts to avoid the read-then-write race where two concurrent
// requests both observe `used == limit - 1` and both increment, exceeding the
// limit. The whole check + increment runs in a single SQLite transaction.
//
// `limit === null` means unlimited — we still increment (for analytics) and
// always allow. Caller is responsible for resolving the tier-specific limit
// from CALL_LIMITS before invoking.
export interface ConsumeUsageResult {
  allowed: boolean
  used:    number   // post-increment when allowed; current count when blocked
  limit:   number | null
}

export function tryConsumeUsage(
  deviceId: string,
  type:     _UsageType,
  limit:    number | null
): ConsumeUsageResult {
  const txn = db.transaction((): ConsumeUsageResult => {
    const usage = getUsageToday(deviceId)
    const field: keyof UsageRow =
      type === 'score'   ? 'jobs_scored'   :
      type === 'analyze' ? 'analyze_calls' :
                           'profile_calls'
    const used = usage[field]

    if (limit !== null && used >= limit) {
      return { allowed: false, used, limit }
    }

    incrementUsage(deviceId, type)
    return { allowed: true, used: used + 1, limit }
  })

  return txn()
}

export function getTodayPanelOpenCount(deviceId: string): number {
  const row = _stmt(stmtPanelCount, 'panelCount').get(deviceId) as { c: number } | undefined
  return row?.c ?? 0
}

export interface LogEntry {
  deviceId:  string | null
  endpoint:  string
  latencyMs: number
  status:    number
  error?:    string
}

export function logRequest(entry: LogEntry): void {
  try {
    _stmt(stmtInsertLog, 'insertLog').run({
      id:        randomUUID(),
      deviceId:  entry.deviceId ?? null,
      endpoint:  entry.endpoint,
      latencyMs: entry.latencyMs,
      status:    entry.status,
      error:     entry.error ?? null,
    })
  } catch (err) {
    console.error('Failed to write request log:', err)
  }
}

// ── Settings helpers ──────────────────────────────────────────────────────────

export function getSetting(key: string): string | null {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any
    return row?.value ?? null
  } catch { return null }
}

export function setSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}

export function isSubscriptionsEnabled(): boolean {
  return getSetting('subscriptions_enabled') === 'true'
}

// ── Tier helpers ──────────────────────────────────────────────────────────────

export type StoredTier    = 'free' | 'pro'
export type EffectiveTier = 'free' | 'pro' | 'trial'

// Returns the tier enforced right now for this device.
// Priority order:
//   1. Admin tier_override → always wins
//   2. subscriptions_enabled=false → everyone is Pro (admin override mode)
//   3. Within 7-day trial → trial (full access, same as Pro)
//   4. subscription_status='active' → pro
//   5. subscription_status='past_due' AND within grace period → pro
//   6. subscription_status='cancelled' AND ends_at in future → pro (paid through period)
//   7. Everything else → free
export function getEffectiveTier(deviceId: string): EffectiveTier {
  const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(deviceId) as any
  if (!device) return 'free'

  if (device.tier_override === 'pro') return 'pro'

  if (!isSubscriptionsEnabled()) return 'pro'

  if (device.trial_started_at) {
    const trialEnd = new Date(
      new Date(device.trial_started_at).getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000
    )
    if (new Date() < trialEnd) return 'trial'
  }

  if (device.tier === 'pro') {
    if (device.subscription_status === 'active') return 'pro'

    // past_due — check grace period.
    // No past_due_at on legacy rows that pre-date this column → trust LS and
    // stay Pro; expireStaleSubscriptions will catch up on the hourly run.
    if (device.subscription_status === 'past_due') {
      if (!device.past_due_at) return 'pro'
      const graceEnd = new Date(
        new Date(device.past_due_at).getTime() + PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000
      )
      if (new Date() < graceEnd) return 'pro'
      // grace expired — fall through to free
    }

    if (device.subscription_status === 'cancelled' && device.subscription_ends_at) {
      if (new Date(device.subscription_ends_at) > new Date()) return 'pro'
    }
  }

  return 'free'
}

// ── Panel open gate ───────────────────────────────────────────────────────────

export interface PanelOpenResult {
  allowed:       boolean
  alreadyOpened: boolean
  usedToday:     number
  limit:         number | null
  trial:         boolean
  trialDaysLeft: number | null
  resetAt:       string | null
  needs_upgrade: boolean
}

function _nextMidnightUTC(): string {
  const d = new Date()
  d.setUTCHours(24, 0, 0, 0)
  return d.toISOString()
}

function _trialDaysLeft(trialStartedAt: string): number {
  const end = new Date(new Date(trialStartedAt).getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000)
  return Math.max(1, Math.ceil((end.getTime() - Date.now()) / 86400000))
}

export function recordPanelOpen(deviceId: string, jobId: string): PanelOpenResult {
  // The whole gate (read tier → check existing → count → insert) must be atomic.
  // Without a transaction, two concurrent panel opens can both see usedToday == limit-1
  // and both insert, exceeding the limit. better-sqlite3's db.transaction() runs the
  // function inside a SQLite transaction, serialising it against other writers.
  const txn = db.transaction((deviceId: string, jobId: string): PanelOpenResult => {
    const tier   = getEffectiveTier(deviceId)
    const device = db.prepare(`SELECT trial_started_at FROM devices WHERE id = ?`).get(deviceId) as any
    const limit  = PANEL_LIMITS[tier]

    // ── Pro: unlimited, record for analytics ──────────────────────────────────
    if (tier === 'pro') {
      _stmt(stmtPanelInsert, 'panelInsert').run(deviceId, jobId || randomUUID())
      return {
        allowed: true, alreadyOpened: false, usedToday: 0,
        limit: null, trial: false, trialDaysLeft: null,
        resetAt: null, needs_upgrade: false,
      }
    }

    // ── Trial & Free: check same-job re-open (free slot) ─────────────────────
    if (jobId) {
      const exists = _stmt(stmtPanelExists, 'panelExists').get(deviceId, jobId)
      if (exists) {
        return {
          allowed: true, alreadyOpened: true,
          usedToday: getTodayPanelOpenCount(deviceId),
          limit,
          trial:        tier === 'trial',
          trialDaysLeft: device?.trial_started_at ? _trialDaysLeft(device.trial_started_at) : null,
          resetAt: null, needs_upgrade: false,
        }
      }
    }

    const usedToday = getTodayPanelOpenCount(deviceId)

    // ── Limit hit ─────────────────────────────────────────────────────────────
    if (limit !== null && usedToday >= limit) {
      return {
        allowed: false, alreadyOpened: false, usedToday,
        limit,
        trial:        tier === 'trial',
        trialDaysLeft: device?.trial_started_at ? _trialDaysLeft(device.trial_started_at) : null,
        resetAt: _nextMidnightUTC(),
        needs_upgrade: isSubscriptionsEnabled(),
      }
    }

    // ── Within limit — record and allow ──────────────────────────────────────
    _stmt(stmtPanelInsert, 'panelInsert').run(deviceId, jobId || randomUUID())

    return {
      allowed: true, alreadyOpened: false, usedToday: usedToday + 1,
      limit,
      trial:        tier === 'trial',
      trialDaysLeft: device?.trial_started_at ? _trialDaysLeft(device.trial_started_at) : null,
      resetAt: null, needs_upgrade: false,
    }
  })

  return txn(deviceId, jobId)
}

// ── Subscription helpers ──────────────────────────────────────────────────────

export interface SubscriptionUpdate {
  deviceId:       string
  email:          string | null
  subscriptionId: string
  status:         string
  tier:           StoredTier
  endsAt:         string | null
}

export function updateDeviceSubscription(params: SubscriptionUpdate): void {
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE devices SET
        email                = COALESCE(?, email),
        tier                 = ?,
        subscription_id      = ?,
        subscription_status  = ?,
        subscription_ends_at = ?,
        last_seen            = datetime('now')
      WHERE id = ?
    `).run(
      params.email, params.tier, params.subscriptionId,
      params.status, params.endsAt, params.deviceId
    )

    // past_due_at lifecycle:
    //   transition INTO past_due (and not already set) → stamp now (UTC, ISO-8601)
    //   anything else                                  → clear
    //
    // Why "not already set": LemonSqueezy fires payment_failed multiple times
    // during dunning retries. We want past_due_at to mark the FIRST failure,
    // not the most recent — that's what the grace period counts from.
    if (params.status === 'past_due') {
      db.prepare(`
        UPDATE devices SET past_due_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND past_due_at IS NULL
      `).run(params.deviceId)
    } else {
      db.prepare(`UPDATE devices SET past_due_at = NULL WHERE id = ?`).run(params.deviceId)
    }
  })
  tx()
}

export function getDeviceByEmail(email: string): any {
  return db.prepare(`
    SELECT * FROM devices
    WHERE LOWER(email) = LOWER(?) AND subscription_id IS NOT NULL
    ORDER BY last_seen DESC LIMIT 1
  `).get(email)
}

export function setTierOverride(deviceId: string, override: 'pro' | null): void {
  db.prepare(`UPDATE devices SET tier_override = ? WHERE id = ?`).run(override, deviceId)
}

// ── Trial activation ──────────────────────────────────────────────────────────
// Returns:
//   'activated'     — trial freshly started
//   'already_active' — this device already has a trial (or has had one)
//   'email_used'    — this email was already used for a trial on another device

export type TrialActivationResult = 'activated' | 'already_active' | 'email_used'

export function activateTrial(deviceId: string, email: string): TrialActivationResult {
  // The whole sequence (check device.trial_started_at → check previous trial by email
  // → UPDATE) must be atomic. Without a transaction, two near-simultaneous requests
  // with the same email on different devices can both pass the previousTrial check
  // and both activate trials — defeating the one-trial-per-email rule.
  const txn = db.transaction((deviceId: string, email: string): TrialActivationResult => {
    const device = db.prepare(`SELECT trial_started_at FROM devices WHERE id = ?`).get(deviceId) as any
    if (!device || device.trial_started_at) return 'already_active'

    // One trial per email address — prevents unlimited trials via reinstall.
    // We check all devices that have ever used this email, not just the current one.
    const previousTrial = db.prepare(`
      SELECT 1 FROM devices
      WHERE LOWER(email) = LOWER(?) AND trial_started_at IS NOT NULL
    `).get(email)
    if (previousTrial) return 'email_used'

    db.prepare(`
      UPDATE devices SET
        trial_started_at = datetime('now'),
        email            = COALESCE(?, email)
      WHERE id = ?
    `).run(email, deviceId)

    return 'activated'
  })

  return txn(deviceId, email)
}

// ── Subscription expiry enforcement ──────────────────────────────────────────
// Demotes subscriptions that have aged out of their grace period.
// Runs on startup and hourly from index.ts as a server-side safety net —
// if LemonSqueezy fails to deliver a webhook, this catches the expiry.
//
// Two cases handled:
//   (a) cancelled subs whose paid-through period has ended
//   (b) past_due subs where the grace window has elapsed
export function expireStaleSubscriptions(): void {
  try {
    const cancelled = db.prepare(`
      UPDATE devices SET
        tier                = 'free',
        subscription_status = 'expired'
      WHERE tier = 'pro'
        AND subscription_status = 'cancelled'
        AND subscription_ends_at IS NOT NULL
        AND datetime(subscription_ends_at) < datetime('now')
    `).run()

    // Past-due grace expiry. We also clear past_due_at since we're moving
    // out of past_due — keeps the column meaningful for any future re-entry.
    const pastDue = db.prepare(`
      UPDATE devices SET
        tier                = 'free',
        subscription_status = 'expired',
        past_due_at         = NULL
      WHERE tier = 'pro'
        AND subscription_status = 'past_due'
        AND past_due_at IS NOT NULL
        AND datetime(past_due_at, ?) < datetime('now')
    `).run(`+${PAST_DUE_GRACE_DAYS} days`)

    const total = cancelled.changes + pastDue.changes
    if (total > 0) {
      console.log(
        `[Expiry] Downgraded ${total} subscription(s) → free ` +
        `(cancelled: ${cancelled.changes}, past_due grace expired: ${pastDue.changes})`
      )
    }
  } catch (err) {
    console.error('[Expiry] Failed to expire stale subscriptions:', err)
  }
}

// ── Log cleanup ───────────────────────────────────────────────────────────────
// Called on startup and every 24 hours from index.ts.
// Cleans request_logs, panel_opens, and usage rows older than 30 days.

const LOG_RETENTION_DAYS = 30

function utcDateDaysAgo(daysBack: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - daysBack)
  return d.toISOString().split('T')[0]
}

export function cleanupOldLogs(): void {
  try {
    const cutoff = utcDateDaysAgo(LOG_RETENTION_DAYS)
    const logs   = db.prepare(`DELETE FROM request_logs WHERE created_at < ?`).run(cutoff)
    const panels = db.prepare(`DELETE FROM panel_opens   WHERE date        < ?`).run(cutoff)
    const usage  = db.prepare(`DELETE FROM usage         WHERE date        < ?`).run(cutoff)
    const total  = logs.changes + panels.changes + usage.changes
    if (total > 0) {
      console.log(
        `[Cleanup] Pruned ${logs.changes} log rows + ` +
        `${panels.changes} panel_open rows + ` +
        `${usage.changes} usage rows`
      )
    }
  } catch (err) {
    console.error('[Cleanup] Failed:', err)
  }
}

export function clearRequestLogs(): { deletedCount: number } {
  try {
    const result = db.prepare(`DELETE FROM request_logs`).run()
    console.log(`[Admin] Cleared ${result.changes} request log rows`)
    return { deletedCount: result.changes }
  } catch (err) {
    console.error('[Admin] clearRequestLogs failed:', err)
    return { deletedCount: 0 }
  }
}
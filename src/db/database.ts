import Database         from 'better-sqlite3'
import type { Statement } from 'better-sqlite3'
import path             from 'path'
import fs               from 'fs'
import { randomUUID }   from 'crypto'

const DATA_DIR = path.join(process.cwd(), 'data')
const DB_PATH  = path.join(DATA_DIR, 'rolevance.db')
fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(DB_PATH)

const TRIAL_DAYS       = 5
const FREE_PANEL_LIMIT = 5

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      device_id     TEXT NOT NULL REFERENCES devices(id),
      date          TEXT NOT NULL DEFAULT (date('now')),
      batch_calls   INTEGER NOT NULL DEFAULT 0,
      analyze_calls INTEGER NOT NULL DEFAULT 0,
      profile_calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (device_id, date)
    )
  `)

  // ── panel_opens ────────────────────────────────────────────────────────────
  // Tracks unique job panel opens per device per day.
  // The composite PRIMARY KEY (device_id, date, job_id) is the uniqueness
  // constraint — INSERT OR IGNORE on a duplicate is a silent no-op,
  // so the same job opened twice on the same day costs only one slot.
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

  // ── Indexes ───────────────────────────────────────────────────────────────
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_date   ON usage (date)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs (created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_device  ON request_logs (device_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_status  ON request_logs (status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_panel_device ON panel_opens (device_id, date)`)

  // ── Migrations ────────────────────────────────────────────────────────────
  const deviceMigrations = [
    `ALTER TABLE devices ADD COLUMN email                TEXT DEFAULT NULL`,
    `ALTER TABLE devices ADD COLUMN tier                 TEXT DEFAULT 'free'`,
    `ALTER TABLE devices ADD COLUMN tier_override        TEXT DEFAULT NULL`,
    `ALTER TABLE devices ADD COLUMN subscription_id      TEXT DEFAULT NULL`,
    `ALTER TABLE devices ADD COLUMN subscription_status  TEXT DEFAULT NULL`,
    `ALTER TABLE devices ADD COLUMN subscription_ends_at TEXT DEFAULT NULL`,
    // trial_started_at: set to datetime('now') on new installs via upsertDevice.
    // Existing devices get backfilled to first_seen below so long-time users
    // are not accidentally granted a fresh 5-day trial on this deploy.
    `ALTER TABLE devices ADD COLUMN trial_started_at TEXT DEFAULT NULL`,
  ]
  for (const sql of deviceMigrations) {
    try { db.exec(sql) } catch { /* column already exists */ }
  }

  // Backfill existing devices — trial started when they first installed
  db.exec(`
    UPDATE devices SET trial_started_at = first_seen
    WHERE trial_started_at IS NULL
  `)

  // ── Seed default settings ─────────────────────────────────────────────────
  const subRow = db.prepare(`SELECT value FROM settings WHERE key = 'subscriptions_enabled'`).get()
  if (!subRow) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('subscriptions_enabled', 'false')`).run()
  }

  _initStatements()
  console.log('Database initialized')
}

// ── Prepared statements ───────────────────────────────────────────────────────
type Stmt = Statement<unknown[]>

let stmtUpsertDevice: Stmt | null = null
let stmtGetUsage:     Stmt | null = null
let stmtIncrBatch:    Stmt | null = null
let stmtIncrAnalyze:  Stmt | null = null
let stmtIncrProfile:  Stmt | null = null
let stmtInsertLog:    Stmt | null = null
let stmtPanelCount:   Stmt | null = null
let stmtPanelExists:  Stmt | null = null
let stmtPanelInsert:  Stmt | null = null

function _initStatements(): void {
  // trial_started_at set only on first INSERT — ON CONFLICT only bumps last_seen
  stmtUpsertDevice = db.prepare(`
    INSERT INTO devices (id, trial_started_at) VALUES (?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET last_seen = datetime('now')
  `)

  stmtGetUsage = db.prepare(`
    SELECT batch_calls, analyze_calls, profile_calls
    FROM   usage
    WHERE  device_id = ? AND date = date('now')
  `)

  stmtIncrBatch = db.prepare(`
    INSERT INTO usage (device_id, batch_calls) VALUES (?, 1)
    ON CONFLICT(device_id, date) DO UPDATE SET batch_calls = batch_calls + 1
  `)

  stmtIncrAnalyze = db.prepare(`
    INSERT INTO usage (device_id, analyze_calls) VALUES (?, 1)
    ON CONFLICT(device_id, date) DO UPDATE SET analyze_calls = analyze_calls + 1
  `)

  stmtIncrProfile = db.prepare(`
    INSERT INTO usage (device_id, profile_calls) VALUES (?, 1)
    ON CONFLICT(device_id, date) DO UPDATE SET profile_calls = profile_calls + 1
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
  stmtUpsertDevice?.run(id)
}

export interface UsageRow {
  batch_calls:   number
  analyze_calls: number
  profile_calls: number
}

export function getUsageToday(deviceId: string): UsageRow {
  const row = stmtGetUsage?.get(deviceId) as UsageRow | undefined
  return row ?? { batch_calls: 0, analyze_calls: 0, profile_calls: 0 }
}

export type UsageType = 'batch' | 'analyze' | 'profile'

export function incrementUsage(deviceId: string, type: UsageType): void {
  if (type === 'batch')   stmtIncrBatch?.run(deviceId)
  if (type === 'analyze') stmtIncrAnalyze?.run(deviceId)
  if (type === 'profile') stmtIncrProfile?.run(deviceId)
}

export function getTodayPanelOpenCount(deviceId: string): number {
  const row = stmtPanelCount?.get(deviceId) as { c: number } | undefined
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
    stmtInsertLog?.run({
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
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
}

export function isSubscriptionsEnabled(): boolean {
  return getSetting('subscriptions_enabled') === 'true'
}

// ── Tier helpers ──────────────────────────────────────────────────────────────

export type StoredTier   = 'free' | 'pro'
export type EffectiveTier = 'free' | 'pro' | 'trial'

// Returns the tier enforced right now for this device.
// Priority order:
//   1. Admin tier_override → always wins
//   2. subscriptions_enabled=false → everyone is Pro (launch phase)
//   3. Within 5-day trial → trial (full access, same as Pro)
//   4. Active/grace-period paid subscription → pro
//   5. Everything else → free
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
    if (device.subscription_status === 'active')   return 'pro'
    if (device.subscription_status === 'past_due') return 'pro'
    if (device.subscription_status === 'cancelled' && device.subscription_ends_at) {
      if (new Date(device.subscription_ends_at) > new Date()) return 'pro'
    }
  }

  return 'free'
}

// ── Panel open gate ───────────────────────────────────────────────────────────

export interface PanelOpenResult {
  allowed:       boolean
  alreadyOpened: boolean      // true = same jobId already opened today (free re-open)
  usedToday:     number       // unique panels opened today (free tier only)
  limit:         number | null // null = unlimited (pro/trial)
  trial:         boolean
  trialDaysLeft: number | null
  resetAt:       string | null // ISO midnight UTC — present when not allowed
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
  const tier   = getEffectiveTier(deviceId)
  const device = db.prepare(`SELECT trial_started_at FROM devices WHERE id = ?`).get(deviceId) as any

  // ── Trial: unlimited access, still record for analytics ───────────────────
  if (tier === 'trial') {
    stmtPanelInsert?.run(deviceId, jobId || randomUUID())
    return {
      allowed: true, alreadyOpened: false, usedToday: 0,
      limit: null, trial: true,
      trialDaysLeft: device?.trial_started_at ? _trialDaysLeft(device.trial_started_at) : null,
      resetAt: null, needs_upgrade: false,
    }
  }

  // ── Pro: unlimited access, record for analytics ───────────────────────────
  if (tier === 'pro') {
    stmtPanelInsert?.run(deviceId, jobId || randomUUID())
    return {
      allowed: true, alreadyOpened: false, usedToday: 0,
      limit: null, trial: false, trialDaysLeft: null,
      resetAt: null, needs_upgrade: false,
    }
  }

  // ── Free tier ─────────────────────────────────────────────────────────────

  // Same job already opened today = free re-open, doesn't cost a slot
  if (jobId) {
    const exists = stmtPanelExists?.get(deviceId, jobId)
    if (exists) {
      return {
        allowed: true, alreadyOpened: true,
        usedToday: getTodayPanelOpenCount(deviceId),
        limit: FREE_PANEL_LIMIT, trial: false, trialDaysLeft: null,
        resetAt: null, needs_upgrade: false,
      }
    }
  }

  const usedToday = getTodayPanelOpenCount(deviceId)

  // Limit hit
  if (usedToday >= FREE_PANEL_LIMIT) {
    return {
      allowed: false, alreadyOpened: false, usedToday,
      limit: FREE_PANEL_LIMIT, trial: false, trialDaysLeft: null,
      resetAt: _nextMidnightUTC(), needs_upgrade: isSubscriptionsEnabled(),
    }
  }

  // Within limit — record and allow
  stmtPanelInsert?.run(deviceId, jobId || randomUUID())

  return {
    allowed: true, alreadyOpened: false, usedToday: usedToday + 1,
    limit: FREE_PANEL_LIMIT, trial: false, trialDaysLeft: null,
    resetAt: null, needs_upgrade: false,
  }
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

// ── Log cleanup ───────────────────────────────────────────────────────────────
// Called on startup and every 24 hours from index.ts.
// Cleans both request_logs and panel_opens older than 30 days.

const LOG_RETENTION_DAYS = 30

// Returns a YYYY-MM-DD date string N days back from today (UTC).
// Used for parameterized queries — avoids string interpolation in SQL.
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
    const total  = logs.changes + panels.changes
    if (total > 0) {
      console.log(`[Cleanup] Pruned ${logs.changes} log rows + ${panels.changes} panel_open rows`)
    }
  } catch (err) {
    console.error('[Cleanup] Failed:', err)
  }
}

// Clears all rows from request_logs immediately. Called by DELETE /admin/logs.
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
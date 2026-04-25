import Database         from 'better-sqlite3'
import type { Statement } from 'better-sqlite3'
import path             from 'path'
import fs               from 'fs'
import { randomUUID }   from 'crypto'

const DATA_DIR = path.join(process.cwd(), 'data')
const DB_PATH  = path.join(DATA_DIR, 'jobsift.db')
fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(DB_PATH)

export function initDatabase(): void {
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // ── devices ──────────────────────────────────────────────────────────────
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

  // ── request_logs ───────────────────────────────────────────────────────────
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

  // ── settings ───────────────────────────────────────────────────────────────
  // Key-value store for feature flags. Currently used for subscriptions toggle.
  // subscriptions_enabled = 'false' → everyone gets Pro limits (launch phase)
  // subscriptions_enabled = 'true'  → tiers enforced, paywall active
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  // ── Indexes ────────────────────────────────────────────────────────────────
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_date   ON usage (date)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs (created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_device  ON request_logs (device_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_status  ON request_logs (status)`)

  // ── Migrations: subscription columns on devices ────────────────────────────
  // Safe ALTER TABLE — silently ignored if column already exists.
  const deviceMigrations = [
    `ALTER TABLE devices ADD COLUMN email               TEXT DEFAULT NULL`,
    `ALTER TABLE devices ADD COLUMN tier                TEXT DEFAULT 'free'`,
    `ALTER TABLE devices ADD COLUMN tier_override       TEXT DEFAULT NULL`,
    `ALTER TABLE devices ADD COLUMN subscription_id     TEXT DEFAULT NULL`,
    `ALTER TABLE devices ADD COLUMN subscription_status TEXT DEFAULT NULL`,
    `ALTER TABLE devices ADD COLUMN subscription_ends_at TEXT DEFAULT NULL`,
  ]
  for (const sql of deviceMigrations) {
    try { db.exec(sql) } catch { /* column already exists */ }
  }

  // ── Seed default settings ──────────────────────────────────────────────────
  // Only insert if not present — never overwrite admin changes on restart.
  const subRow = db.prepare(`SELECT value FROM settings WHERE key = 'subscriptions_enabled'`).get()
  if (!subRow) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('subscriptions_enabled', 'false')`).run()
  }

  _initStatements()
  console.log('Database initialized')
}

// ── Prepared statements ────────────────────────────────────────────────────────
type Stmt = Statement<unknown[]>

let stmtUpsertDevice:  Stmt | null = null
let stmtGetUsage:      Stmt | null = null
let stmtIncrBatch:     Stmt | null = null
let stmtIncrAnalyze:   Stmt | null = null
let stmtIncrProfile:   Stmt | null = null
let stmtInsertLog:     Stmt | null = null

function _initStatements(): void {
  stmtUpsertDevice = db.prepare(`
    INSERT INTO devices (id) VALUES (?)
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
}

// ── Core device helpers ────────────────────────────────────────────────────────

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

// ── Settings helpers ───────────────────────────────────────────────────────────

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

// Reads from DB each call — intentional, so admin toggle takes effect immediately
// without restarting the server.
export function isSubscriptionsEnabled(): boolean {
  return getSetting('subscriptions_enabled') === 'true'
}

// ── Subscription & tier helpers ────────────────────────────────────────────────

export type Tier = 'free' | 'pro'

// Returns the tier that should actually be enforced for this device.
// Decision tree:
//   1. tier_override set by admin → use it
//   2. subscriptions_enabled=false → 'pro' (everyone gets Pro in launch phase)
//   3. subscription status active/cancelled-but-not-expired → 'pro'
//   4. everything else → 'free'
export function getEffectiveTier(deviceId: string): Tier {
  const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(deviceId) as any
  if (!device) return 'free'

  // Admin manual override always wins
  if (device.tier_override === 'pro') return 'pro'

  // When subscriptions are off, everyone is Pro
  if (!isSubscriptionsEnabled()) return 'pro'

  // Paid subscriber with active or cancelled-but-period-not-ended subscription
  if (device.tier === 'pro') {
    if (device.subscription_status === 'active') return 'pro'
    if (device.subscription_status === 'past_due') return 'pro' // grace period
    if (device.subscription_status === 'cancelled' && device.subscription_ends_at) {
      // Still Pro until the billing period ends
      if (new Date(device.subscription_ends_at) > new Date()) return 'pro'
    }
  }

  return 'free'
}

export interface SubscriptionUpdate {
  deviceId:       string
  email:          string | null
  subscriptionId: string
  status:         string
  tier:           Tier
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
    params.email,
    params.tier,
    params.subscriptionId,
    params.status,
    params.endsAt,
    params.deviceId
  )
}

// Used by the restore flow: find a device that holds this email's subscription
export function getDeviceByEmail(email: string): any {
  return db.prepare(`
    SELECT * FROM devices
    WHERE LOWER(email) = LOWER(?)
      AND subscription_id IS NOT NULL
    ORDER BY last_seen DESC
    LIMIT 1
  `).get(email)
}

// Admin action: manually set or remove a tier override for a device
export function setTierOverride(deviceId: string, override: 'pro' | null): void {
  db.prepare(`UPDATE devices SET tier_override = ? WHERE id = ?`).run(override, deviceId)
}

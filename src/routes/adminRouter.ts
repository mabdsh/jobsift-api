import { Router, Request, Response, NextFunction } from 'express'
import { db, getSetting, setSetting, setTierOverride, clearRequestLogs } from '../db/database'
import { PRICING } from '../config/limits'

export const adminRouter = Router()

// ── Brute-force protection (SQLite-backed) ────────────────────────────────────
// Persisted in the settings table so lockouts survive server restarts.
// Key format: `admin_lockout:<ip>`

const MAX_ATTEMPTS = 5
const LOCKOUT_MS   = 15 * 60 * 1000

interface AttemptRecord { count: number; lockedUntil: number | null }

function getClientIp(req: Request): string {
  return (req.headers['x-real-ip'] as string) || req.ip || 'unknown'
}

function _getLockout(ip: string): AttemptRecord {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`admin_lockout:${ip}`) as any
    if (row?.value) return JSON.parse(row.value) as AttemptRecord
  } catch {}
  return { count: 0, lockedUntil: null }
}

function _setLockout(ip: string, record: AttemptRecord): void {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(`admin_lockout:${ip}`, JSON.stringify(record))
}

function _clearLockout(ip: string): void {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(`admin_lockout:${ip}`)
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const ip     = getClientIp(req)
  const record = _getLockout(ip)

  if (record.lockedUntil !== null) {
    if (Date.now() < record.lockedUntil) {
      const remaining = Math.ceil((record.lockedUntil - Date.now()) / 60000)
      res.status(429).json({
        error:   'locked_out',
        message: `Too many failed attempts. Try again in ${remaining} minute${remaining !== 1 ? 's' : ''}.`,
      })
      return
    }
    // Lockout expired — clear it
    _clearLockout(ip)
    record.count = 0
    record.lockedUntil = null
  }

  const secret = req.headers['x-admin-secret'] as string | undefined
  if (!secret || !process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    record.count++
    if (record.count >= MAX_ATTEMPTS) {
      record.lockedUntil = Date.now() + LOCKOUT_MS
      _setLockout(ip, record)
      console.warn(`[Admin] IP ${ip} locked out after ${MAX_ATTEMPTS} failed attempts`)
      res.status(429).json({
        error:   'locked_out',
        message: 'Too many failed attempts. Try again in 15 minutes.',
      })
    } else {
      _setLockout(ip, record)
      const left = MAX_ATTEMPTS - record.count
      res.status(403).json({
        error:   'forbidden',
        message: `Invalid admin secret. ${left} attempt${left !== 1 ? 's' : ''} remaining before lockout.`,
      })
    }
    return
  }

  _clearLockout(ip)
  next()
}

adminRouter.use(requireAdmin)

// ── Date helper ────────────────────────────────────────────────────────────────
function utcDateDaysAgo(daysBack: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - daysBack)
  return d.toISOString().split('T')[0]
}

// ── GET /admin/stats ───────────────────────────────────────────────────────────
adminRouter.get('/stats', (_req: Request, res: Response) => {
  const totalDevices = (db.prepare(`SELECT COUNT(*) as c FROM devices`).get() as any).c
  const newToday     = (db.prepare(`SELECT COUNT(*) as c FROM devices WHERE date(first_seen) = date('now')`).get() as any).c
  const activeToday  = (db.prepare(`SELECT COUNT(DISTINCT device_id) as c FROM usage WHERE date = date('now')`).get() as any).c

  const callsToday = db.prepare(`
    SELECT COALESCE(SUM(jobs_scored),0)   as scored,
           COALESCE(SUM(analyze_calls),0) as analyze,
           COALESCE(SUM(profile_calls),0) as profile
    FROM usage WHERE date = date('now')
  `).get() as any

  const callsWeek = db.prepare(`
    SELECT COALESCE(SUM(jobs_scored),0)   as scored,
           COALESCE(SUM(analyze_calls),0) as analyze,
           COALESCE(SUM(profile_calls),0) as profile
    FROM usage WHERE date >= ?
  `).get(utcDateDaysAgo(6)) as any

  const panelOpensToday = (db.prepare(`
    SELECT COUNT(*) as c FROM panel_opens WHERE date = date('now')
  `).get() as any).c

  const trialUsersNow = (db.prepare(`
    SELECT COUNT(*) as c FROM devices
    WHERE trial_started_at IS NOT NULL
      AND datetime(trial_started_at, '+7 days') > datetime('now')
      AND (tier != 'pro' OR tier IS NULL)
      AND (tier_override IS NULL OR tier_override != 'pro')
  `).get() as any).c

  const perf = db.prepare(`
    SELECT COALESCE(AVG(latency_ms),0) as avg_lat,
           COALESCE(MAX(latency_ms),0) as max_lat,
           COUNT(*)                    as total_reqs
    FROM request_logs WHERE date(created_at) = date('now') AND status = 200
  `).get() as any

  const errorsToday = (db.prepare(`
    SELECT COUNT(*) as c FROM request_logs
    WHERE status >= 500 AND date(created_at) = date('now')
  `).get() as any).c

  res.json({
    devices: {
      total:        totalDevices,
      new_today:    newToday,
      active_today: activeToday,
      trial_now:    trialUsersNow,
    },
    calls_today: {
      scored:        callsToday.scored,
      analyze:      callsToday.analyze,
      profile:      callsToday.profile,
      panel_opens:  panelOpensToday,
      total:        callsToday.scored + callsToday.analyze + callsToday.profile,
    },
    calls_week: {
      scored:   callsWeek.scored,
      analyze: callsWeek.analyze,
      profile: callsWeek.profile,
      total:   callsWeek.scored + callsWeek.analyze + callsWeek.profile,
    },
    performance: {
      avg_latency_ms:            Math.round(perf.avg_lat),
      max_latency_ms:            perf.max_lat,
      successful_requests_today: perf.total_reqs,
      errors_today:              errorsToday,
    },
  })
})

// ── GET /admin/daily ───────────────────────────────────────────────────────────
adminRouter.get('/daily', (req: Request, res: Response) => {
  const days   = Math.min(parseInt(req.query.days as string) || 7, 90)
  const cutoff = utcDateDaysAgo(days - 1)

  const rows = db.prepare(`
    SELECT date,
      COALESCE(SUM(jobs_scored),0)                             as scored,
      COALESCE(SUM(analyze_calls),0)                           as analyze,
      COALESCE(SUM(profile_calls),0)                           as profile,
      COALESCE(SUM(jobs_scored+analyze_calls+profile_calls),0) as total
    FROM usage
    WHERE date >= ?
    GROUP BY date
    ORDER BY date ASC
  `).all(cutoff) as any[]

  res.json({ days, data: rows })
})

// ── GET /admin/latency ─────────────────────────────────────────────────────────
adminRouter.get('/latency', (req: Request, res: Response) => {
  const days   = Math.min(parseInt(req.query.days as string) || 7, 90)
  const cutoff = utcDateDaysAgo(days - 1)

  const rows = db.prepare(`
    SELECT date(created_at)        as date,
           ROUND(AVG(latency_ms))  as avg_ms,
           MAX(latency_ms)         as max_ms,
           COUNT(*)                as requests
    FROM request_logs
    WHERE date(created_at) >= ? AND status = 200
    GROUP BY date(created_at)
    ORDER BY date ASC
  `).all(cutoff) as any[]

  res.json({ days, data: rows })
})

// ── GET /admin/usage ───────────────────────────────────────────────────────────
adminRouter.get('/usage', (req: Request, res: Response) => {
  const days   = Math.min(parseInt(req.query.days  as string) || 7,  90)
  const limit  = Math.min(parseInt(req.query.limit as string) || 20, 100)
  const cutoff = utcDateDaysAgo(days)

  const rows = db.prepare(`
    SELECT d.id as device_id, d.tier, d.tier_override, d.subscription_status, d.email,
      SUM(u.jobs_scored)   as scored,
      SUM(u.analyze_calls) as analyze,
      SUM(u.profile_calls) as profile,
      SUM(u.jobs_scored+u.analyze_calls+u.profile_calls) as total,
      MIN(u.date) as first_active, MAX(u.date) as last_active
    FROM usage u
    JOIN devices d ON d.id = u.device_id
    WHERE u.date >= ?
    GROUP BY u.device_id
    ORDER BY total DESC
    LIMIT ?
  `).all(cutoff, limit) as any[]

  res.json({ days, count: rows.length, devices: rows })
})

// ── GET /admin/logs ────────────────────────────────────────────────────────────
adminRouter.get('/logs', (req: Request, res: Response) => {
  const limit      = Math.min(parseInt(req.query.limit as string) || 100, 500)
  const errorsOnly = req.query.errors === 'true'
  const endpoint   = req.query.endpoint as string | undefined

  const conditions: string[] = []
  const params: any[]        = []

  if (errorsOnly) { conditions.push('status >= 400') }
  if (endpoint)   { conditions.push('endpoint = ?'); params.push(endpoint) }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = db.prepare(`
    SELECT id, device_id, endpoint, latency_ms, status, error, created_at
    FROM request_logs
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit) as any[]

  res.json({ count: rows.length, logs: rows })
})

// ── DELETE /admin/logs ─────────────────────────────────────────────────────────
adminRouter.delete('/logs', (_req: Request, res: Response) => {
  const { deletedCount } = clearRequestLogs()
  res.json({
    ok:           true,
    deletedCount,
    message:      `Cleared ${deletedCount} request log ${deletedCount === 1 ? 'entry' : 'entries'}.`,
  })
})

// ── GET /admin/subscription/stats ─────────────────────────────────────────────
adminRouter.get('/subscription/stats', (_req: Request, res: Response) => {
  const subsEnabled   = getSetting('subscriptions_enabled') === 'true'
  // MRR estimate uses the monthly price from config/limits.ts.
  // Yearly subscribers pay monthly_equivalent ≈ pricing.yearly_usd / 12,
  // so this is a slight overestimate for that segment. Acceptable for an
  // admin dashboard metric.
  const pricePerMonth = PRICING.monthly_usd

  const tierCounts = db.prepare(`
    SELECT tier, COUNT(*) as count FROM devices GROUP BY tier
  `).all() as any[]

  const statusCounts = db.prepare(`
    SELECT subscription_status, COUNT(*) as count
    FROM devices WHERE subscription_status IS NOT NULL
    GROUP BY subscription_status
  `).all() as any[]

  const overridePro = (db.prepare(`
    SELECT COUNT(*) as c FROM devices WHERE tier_override = 'pro'
  `).get() as any).c

  const revenueDevices = (db.prepare(`
    SELECT COUNT(*) as c FROM devices WHERE subscription_status = 'active'
  `).get() as any).c

  const trialActive = (db.prepare(`
    SELECT COUNT(*) as c FROM devices
    WHERE trial_started_at IS NOT NULL
      AND datetime(trial_started_at, '+7 days') > datetime('now')
  `).get() as any).c

  res.json({
    subscriptions_enabled: subsEnabled,
    tier_counts:           Object.fromEntries(tierCounts.map(r => [r.tier, r.count])),
    status_counts:         Object.fromEntries(statusCounts.map(r => [r.subscription_status, r.count])),
    override_pro:          overridePro,
    active_subscribers:    revenueDevices,
    trial_active:          trialActive,
    estimated_mrr:         Math.round(revenueDevices * pricePerMonth * 100) / 100,
  })
})

// ── POST /admin/subscription/toggle ───────────────────────────────────────────
adminRouter.post('/subscription/toggle', (_req: Request, res: Response) => {
  const current = getSetting('subscriptions_enabled') === 'true'
  const next    = !current
  setSetting('subscriptions_enabled', String(next))
  console.log(`Subscriptions ${next ? 'ENABLED' : 'DISABLED'} by admin`)
  res.json({
    ok:                    true,
    subscriptions_enabled: next,
    message:               next
      ? 'Subscriptions enabled — free tier limits now enforced.'
      : 'Subscriptions disabled — all users get Pro limits.',
  })
})

// ── GET /admin/subscription/devices ───────────────────────────────────────────
adminRouter.get('/subscription/devices', (req: Request, res: Response) => {
  const q     = (req.query.q as string ?? '').trim()
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50)

  if (!q) {
    const rows = db.prepare(`
      SELECT id, email, tier, tier_override, subscription_id, subscription_status,
             subscription_ends_at, first_seen, last_seen
      FROM devices WHERE subscription_id IS NOT NULL
      ORDER BY last_seen DESC
      LIMIT ?
    `).all(limit) as any[]
    res.json({ count: rows.length, devices: rows })
    return
  }

  const rows = db.prepare(`
    SELECT id, email, tier, tier_override, subscription_id, subscription_status,
           subscription_ends_at, first_seen, last_seen
    FROM devices
    WHERE LOWER(email) LIKE LOWER(?) OR id LIKE ?
    ORDER BY last_seen DESC
    LIMIT ?
  `).all(`%${q}%`, `${q}%`, limit) as any[]

  res.json({ count: rows.length, devices: rows })
})

// ── POST /admin/devices/:id/grant-pro ─────────────────────────────────────────
adminRouter.post('/devices/:id/grant-pro', (req: Request, res: Response) => {
  const deviceId = req.params.id as string
  const device   = db.prepare(`SELECT id FROM devices WHERE id = ?`).get(deviceId)
  if (!device) { res.status(404).json({ error: 'device_not_found' }); return }
  setTierOverride(deviceId, 'pro')
  res.json({ ok: true, message: `Device ${deviceId.substring(0, 8)}… granted Pro override.` })
})

// ── DELETE /admin/devices/:id/grant-pro ───────────────────────────────────────
adminRouter.delete('/devices/:id/grant-pro', (req: Request, res: Response) => {
  const deviceId = req.params.id as string
  const device   = db.prepare(`SELECT id FROM devices WHERE id = ?`).get(deviceId)
  if (!device) { res.status(404).json({ error: 'device_not_found' }); return }
  setTierOverride(deviceId, null)
  res.json({ ok: true, message: `Pro override removed from device ${deviceId.substring(0, 8)}….` })
})
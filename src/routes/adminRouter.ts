import { Router, Request, Response } from 'express'
import { db, getSetting, setSetting, setTierOverride } from '../db/database'

export const adminRouter = Router()

function isAdmin(req: Request): boolean {
  return !!process.env.ADMIN_SECRET && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET
}

// ── GET /admin/stats ───────────────────────────────────────────────────────────
adminRouter.get('/stats', (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'forbidden' }); return }

  const totalDevices = (db.prepare(`SELECT COUNT(*) as c FROM devices`).get() as any).c
  const newToday     = (db.prepare(`SELECT COUNT(*) as c FROM devices WHERE date(first_seen) = date('now')`).get() as any).c
  const activeToday  = (db.prepare(`SELECT COUNT(DISTINCT device_id) as c FROM usage WHERE date = date('now')`).get() as any).c

  const callsToday = db.prepare(`
    SELECT COALESCE(SUM(batch_calls),0) as batch, COALESCE(SUM(analyze_calls),0) as analyze, COALESCE(SUM(profile_calls),0) as profile
    FROM usage WHERE date = date('now')
  `).get() as any

  const callsWeek = db.prepare(`
    SELECT COALESCE(SUM(batch_calls),0) as batch, COALESCE(SUM(analyze_calls),0) as analyze, COALESCE(SUM(profile_calls),0) as profile
    FROM usage WHERE date >= date('now', '-7 days')
  `).get() as any

  const perf = db.prepare(`
    SELECT COALESCE(AVG(latency_ms),0) as avg_lat,
           COALESCE(MAX(latency_ms),0) as max_lat,
           COUNT(*) as total_reqs
    FROM request_logs WHERE date(created_at) = date('now') AND status = 200
  `).get() as any

  const errorsToday = (db.prepare(`
    SELECT COUNT(*) as c FROM request_logs WHERE status >= 500 AND date(created_at) = date('now')
  `).get() as any).c

  res.json({
    devices:     { total: totalDevices, new_today: newToday, active_today: activeToday },
    calls_today: { batch: callsToday.batch, analyze: callsToday.analyze, profile: callsToday.profile, total: callsToday.batch + callsToday.analyze + callsToday.profile },
    calls_week:  { batch: callsWeek.batch,  analyze: callsWeek.analyze,  profile: callsWeek.profile,  total: callsWeek.batch  + callsWeek.analyze  + callsWeek.profile  },
    performance: { avg_latency_ms: Math.round(perf.avg_lat), max_latency_ms: perf.max_lat, successful_requests_today: perf.total_reqs, errors_today: errorsToday },
  })
})

// ── GET /admin/daily ───────────────────────────────────────────────────────────
adminRouter.get('/daily', (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'forbidden' }); return }
  const days = Math.min(parseInt(req.query.days as string) || 7, 90)
  const rows = db.prepare(`
    SELECT date,
      COALESCE(SUM(batch_calls),0)   as batch,
      COALESCE(SUM(analyze_calls),0) as analyze,
      COALESCE(SUM(profile_calls),0) as profile,
      COALESCE(SUM(batch_calls+analyze_calls+profile_calls),0) as total
    FROM usage WHERE date >= date('now', '-${days - 1} days')
    GROUP BY date ORDER BY date ASC
  `).all() as any[]
  res.json({ days, data: rows })
})

// ── GET /admin/latency ─────────────────────────────────────────────────────────
adminRouter.get('/latency', (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'forbidden' }); return }
  const days = Math.min(parseInt(req.query.days as string) || 7, 90)
  const rows = db.prepare(`
    SELECT date(created_at) as date,
           ROUND(AVG(latency_ms)) as avg_ms,
           MAX(latency_ms)        as max_ms,
           COUNT(*)               as requests
    FROM request_logs
    WHERE date(created_at) >= date('now', '-${days - 1} days') AND status = 200
    GROUP BY date(created_at) ORDER BY date ASC
  `).all() as any[]
  res.json({ days, data: rows })
})

// ── GET /admin/usage ───────────────────────────────────────────────────────────
adminRouter.get('/usage', (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'forbidden' }); return }
  const days  = Math.min(parseInt(req.query.days  as string) || 7,  90)
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
  const rows = db.prepare(`
    SELECT d.id as device_id, d.tier, d.tier_override, d.subscription_status, d.email,
      SUM(u.batch_calls)   as batch,
      SUM(u.analyze_calls) as analyze,
      SUM(u.profile_calls) as profile,
      SUM(u.batch_calls+u.analyze_calls+u.profile_calls) as total,
      MIN(u.date) as first_active, MAX(u.date) as last_active
    FROM usage u
    JOIN devices d ON d.id = u.device_id
    WHERE u.date >= date('now', '-${days} days')
    GROUP BY u.device_id ORDER BY total DESC LIMIT ?
  `).all(limit) as any[]
  res.json({ days, count: rows.length, devices: rows })
})

// ── GET /admin/logs ────────────────────────────────────────────────────────────
adminRouter.get('/logs', (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'forbidden' }); return }
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
    FROM request_logs ${where} ORDER BY created_at DESC LIMIT ${limit}
  `).all(...params) as any[]
  res.json({ count: rows.length, logs: rows })
})

// ── GET /admin/subscription/stats ─────────────────────────────────────────────
// Subscription overview — used by the admin panel Subscriptions view.
adminRouter.get('/subscription/stats', (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'forbidden' }); return }

  const subsEnabled = getSetting('subscriptions_enabled') === 'true'

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

  res.json({
    subscriptions_enabled: subsEnabled,
    tier_counts:           Object.fromEntries(tierCounts.map(r => [r.tier, r.count])),
    status_counts:         Object.fromEntries(statusCounts.map(r => [r.subscription_status, r.count])),
    override_pro:          overridePro,
    active_subscribers:    revenueDevices,
    estimated_mrr:         revenueDevices * 7, // $7/month
  })
})

// ── POST /admin/subscription/toggle ───────────────────────────────────────────
// Flips the global paywall on or off. The most powerful button in the admin panel.
adminRouter.post('/subscription/toggle', (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'forbidden' }); return }

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
// Search devices by email or device ID prefix for customer support.
adminRouter.get('/subscription/devices', (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'forbidden' }); return }

  const q     = (req.query.q as string ?? '').trim()
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50)

  if (!q) {
    // Return recently active subscribers when no query
    const rows = db.prepare(`
      SELECT id, email, tier, tier_override, subscription_id, subscription_status,
             subscription_ends_at, first_seen, last_seen
      FROM devices
      WHERE subscription_id IS NOT NULL
      ORDER BY last_seen DESC LIMIT ?
    `).all(limit) as any[]
    res.json({ count: rows.length, devices: rows })
    return
  }

  const rows = db.prepare(`
    SELECT id, email, tier, tier_override, subscription_id, subscription_status,
           subscription_ends_at, first_seen, last_seen
    FROM devices
    WHERE LOWER(email) LIKE LOWER(?) OR id LIKE ?
    ORDER BY last_seen DESC LIMIT ?
  `).all(`%${q}%`, `${q}%`, limit) as any[]

  res.json({ count: rows.length, devices: rows })
})

// ── POST /admin/devices/:id/grant-pro ─────────────────────────────────────────
// Give any device Pro access without a payment (comp, support, testing).
adminRouter.post('/devices/:id/grant-pro', (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'forbidden' }); return }

  const deviceId = req.params.id as string
  const device   = db.prepare(`SELECT id FROM devices WHERE id = ?`).get(deviceId)

  if (!device) { res.status(404).json({ error: 'device_not_found' }); return }

  setTierOverride(deviceId, 'pro')
  res.json({ ok: true, message: `Device ${deviceId.substring(0,8)}… granted Pro override.` })
})

// ── DELETE /admin/devices/:id/grant-pro ───────────────────────────────────────
// Remove the Pro override — device falls back to its actual subscription tier.
adminRouter.delete('/devices/:id/grant-pro', (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'forbidden' }); return }

  const deviceId = req.params.id as string
  const device   = db.prepare(`SELECT id FROM devices WHERE id = ?`).get(deviceId)

  if (!device) { res.status(404).json({ error: 'device_not_found' }); return }

  setTierOverride(deviceId, null)
  res.json({ ok: true, message: `Pro override removed from device ${deviceId.substring(0,8)}….` })
})

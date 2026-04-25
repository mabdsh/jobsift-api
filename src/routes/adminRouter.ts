import { Router, Request, Response } from 'express'
import { db }                         from '../db/database'

export const adminRouter = Router()

function isAdmin(req: Request): boolean {
  return (
    !!process.env.ADMIN_SECRET &&
    req.headers['x-admin-secret'] === process.env.ADMIN_SECRET
  )
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
           COALESCE(MIN(latency_ms),0) as min_lat,
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
    performance: { avg_latency_ms: Math.round(perf.avg_lat), min_latency_ms: perf.min_lat, max_latency_ms: perf.max_lat, successful_requests_today: perf.total_reqs, errors_today: errorsToday },
  })
})

// ── GET /admin/daily ───────────────────────────────────────────────────────────
// Per-day call breakdown — drives activity and analytics charts
adminRouter.get('/daily', (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: 'forbidden' }); return }
  const days = Math.min(parseInt(req.query.days as string) || 7, 90)
  const rows = db.prepare(`
    SELECT date,
      COALESCE(SUM(batch_calls),0)   as batch,
      COALESCE(SUM(analyze_calls),0) as analyze,
      COALESCE(SUM(profile_calls),0) as profile,
      COALESCE(SUM(batch_calls+analyze_calls+profile_calls),0) as total
    FROM usage
    WHERE date >= date('now', '-${days - 1} days')
    GROUP BY date ORDER BY date ASC
  `).all() as any[]
  res.json({ days, data: rows })
})

// ── GET /admin/latency ─────────────────────────────────────────────────────────
// Per-day latency stats — drives latency trend chart
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
    SELECT device_id,
      SUM(batch_calls)   as batch, SUM(analyze_calls) as analyze, SUM(profile_calls) as profile,
      SUM(batch_calls+analyze_calls+profile_calls) as total,
      MIN(date) as first_active, MAX(date) as last_active
    FROM usage WHERE date >= date('now', '-${days} days')
    GROUP BY device_id ORDER BY total DESC LIMIT ?
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

import dotenv from 'dotenv'
dotenv.config()

// ── Startup env-var validation ─────────────────────────────────────────────────
// Fail loudly before touching the DB or starting the HTTP server.
// A missing var causes silent mid-request failures that are hard to debug.
const REQUIRED_VARS = [
  'GROQ_API_KEY',
  'CLIENT_SECRET',
  'ADMIN_SECRET',
  'LEMONSQUEEZY_SIGNING_SECRET',
]
const missing = REQUIRED_VARS.filter(k => !process.env[k]?.trim())
if (missing.length) {
  console.error('[Startup] Missing required environment variables:', missing.join(', '))
  console.error('[Startup] Copy .env.example to .env and fill in all values.')
  process.exit(1)
}

import { app }                                           from './api/server'
import { initDatabase, cleanupOldLogs, expireStaleSubscriptions, db } from './db/database'

initDatabase()

// ── Maintenance jobs ───────────────────────────────────────────────────────────
// Run immediately on startup (catches any backlog from downtime),
// then on a repeating schedule.

// Log + usage row cleanup — daily
cleanupOldLogs()
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000)

// Subscription expiry enforcement — hourly safety net.
// If LemonSqueezy fails to deliver subscription_expired, this catches it.
expireStaleSubscriptions()
setInterval(expireStaleSubscriptions, 60 * 60 * 1000)

const PORT = process.env.PORT ?? 3000

const server = app.listen(PORT, () => {
  console.log(`Rolevance API running on port ${PORT}`)
})

// ── Port conflict handling ─────────────────────────────────────────────────────
server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Startup] Port ${PORT} already in use — is another instance running?`)
    console.error('[Startup] Run: pm2 delete rolevance-api  then try again.')
    process.exit(1)
  }
  throw err
})

// ── Graceful shutdown ──────────────────────────────────────────────────────────
function shutdown(signal: string): void {
  console.log(`[Shutdown] ${signal} received — closing gracefully…`)

  server.close(() => {
    try {
      db.close()
      console.log('[Shutdown] Database closed — clean exit')
    } catch (err) {
      console.error('[Shutdown] Error closing database:', err)
    }
    process.exit(0)
  })

  setTimeout(() => {
    console.error('[Shutdown] Forced exit after 10s — connections did not drain')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
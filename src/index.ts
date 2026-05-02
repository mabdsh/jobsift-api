import dotenv from 'dotenv'
dotenv.config()

import { app }                          from './api/server'
import { initDatabase, cleanupOldLogs, db } from './db/database'

initDatabase()

// ── Log cleanup schedule ───────────────────────────────────────────────────────
// Run immediately on startup (catches backlog from any downtime),
// then every 24 hours. Cleans both request_logs and panel_opens.
cleanupOldLogs()
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000)

const PORT = process.env.PORT ?? 3000

const server = app.listen(PORT, () => {
  console.log(`Rolevance API running on port ${PORT}`)
})

// ── Graceful shutdown ──────────────────────────────────────────────────────────
// Stops accepting new connections, lets in-flight requests complete (10s max),
// then closes the SQLite database cleanly before exiting.
// Without this, a SIGTERM from PM2 or the OS could interrupt in-flight
// SQLite writes — WAL mode reduces corruption risk but responses would be
// dropped mid-flight with no reply to the client.
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

  // Force exit if connections don't drain within 10 seconds
  setTimeout(() => {
    console.error('[Shutdown] Forced exit after 10s — connections did not drain')
    process.exit(1)
  }, 10_000).unref() // .unref() so the timer doesn't keep Node alive on its own
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
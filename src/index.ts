import dotenv from 'dotenv'
dotenv.config()

import { app }                          from './api/server'
import { initDatabase, cleanupOldLogs } from './db/database'

initDatabase()

// ── Log cleanup schedule ───────────────────────────────────────────────────────
// Run immediately on startup (catches backlog from any downtime),
// then every 24 hours. Cleans both request_logs and panel_opens.
cleanupOldLogs()
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000)

const PORT = process.env.PORT ?? 3000

app.listen(PORT, () => {
  console.log(`JobSift API running on port ${PORT}`)
})
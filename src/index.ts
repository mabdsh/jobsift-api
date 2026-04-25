import dotenv from 'dotenv'
dotenv.config()

import { app }          from './api/server'
import { initDatabase } from './db/database'

initDatabase()

const PORT = process.env.PORT ?? 3000

app.listen(PORT, () => {
  console.log(`JobSift API running on port ${PORT}`)
})

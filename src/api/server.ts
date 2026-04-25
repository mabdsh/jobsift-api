import express       from 'express'
import cors          from 'cors'
import path          from 'path'

import { requireDevice  } from '../middleware/auth'
import { checkRateLimit } from '../middleware/rateLimit'

import { scoreRouter   } from '../routes/scoreRouter'
import { analyzeRouter } from '../routes/analyzeRouter'
import { profileRouter } from '../routes/profileRouter'
import { adminRouter   } from '../routes/adminRouter'

export const app = express()

app.use(express.json({ limit: '1mb' }))

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin.startsWith('chrome-extension://') || origin.startsWith('http://localhost')) {
      cb(null, true)
    } else {
      cb(new Error('Not allowed by CORS'))
    }
  },
  allowedHeaders: ['Content-Type', 'X-Device-ID', 'X-Client-Secret', 'X-Admin-Secret']
}))

// Admin panel — static HTML served directly from the backend.
// Accessible at /admin-panel — no auth at this layer (the HTML handles it).
app.use('/admin-panel', express.static(path.join(process.cwd(), 'public')))
app.get('/admin-panel', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'))
})

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'jobsift-api' })
})

// API routes — all require device auth + rate limiting
app.use('/api/score',   requireDevice, checkRateLimit('batch'),   scoreRouter)
app.use('/api/analyze', requireDevice, checkRateLimit('analyze'), analyzeRouter)
app.use('/api/profile', requireDevice, checkRateLimit('profile'), profileRouter)

// Admin data API — protected by x-admin-secret header
app.use('/admin', adminRouter)

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' })
})

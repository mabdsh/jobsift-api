import express  from 'express'
import cors     from 'cors'
import path     from 'path'

import { requireDevice  } from '../middleware/auth'
import { checkRateLimit } from '../middleware/rateLimit'

import { scoreRouter        } from '../routes/scoreRouter'
import { analyzeRouter      } from '../routes/analyzeRouter'
import { profileRouter      } from '../routes/profileRouter'
import { panelRouter        } from '../routes/panelRouter'
import { adminRouter        } from '../routes/adminRouter'
import { webhookRouter      } from '../routes/webhookRouter'
import { subscriptionRouter } from '../routes/subscriptionRouter'
import { deviceRouter       } from '../routes/deviceRouter'

export const app = express()

// ── Trust proxy ────────────────────────────────────────────────────────────────
// Tells Express to trust X-Forwarded-For / X-Real-IP set by Nginx.
// Without this, req.ip is always 127.0.0.1 (Nginx loopback).
app.set('trust proxy', 1)

// ── Webhook — MUST come before express.json() ──────────────────────────────────
// LemonSqueezy webhook verification requires the raw request body (Buffer).
// Registering before express.json() ensures it gets express.raw() instead.
app.use(
  '/webhook/lemonsqueezy',
  express.raw({ type: 'application/json' }),
  webhookRouter
)

// ── Standard middleware ────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }))

app.use(cors({
  origin: (origin, cb) => {
    if (
      !origin ||
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('http://localhost')
    ) {
      cb(null, true)
    } else {
      cb(new Error('Not allowed by CORS'))
    }
  },
  allowedHeaders: [
    'Content-Type', 'X-Device-ID', 'X-Client-Secret', 'X-Admin-Secret',
  ],
}))

// ── Admin panel static files ───────────────────────────────────────────────────
app.use('/admin-panel', express.static(path.join(process.cwd(), 'public')))
app.get('/admin-panel', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'))
})

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'jobsift-api' })
})

// ── API routes ─────────────────────────────────────────────────────────────────
//
// Rate limits applied here in middleware, not inside routers, so the pattern
// is consistent across all endpoints and easy to audit in one place:
//
//   batch scoring:  30 calls/day free · unlimited pro/trial
//   deep analysis:  6 calls/day free  · unlimited pro/trial (abuse backstop —
//                   legitimate free users never hit this; panel gate blocks at 5)
//   profile parse:  3 calls/day free  · 20/day pro/trial
//   panel open:     gated inside panelRouter via recordPanelOpen() in the DB
//                   (handles same-job free re-open logic)

app.use('/api/score',        requireDevice, checkRateLimit('batch'),   scoreRouter)
app.use('/api/analyze',      requireDevice, checkRateLimit('analyze'), analyzeRouter)
app.use('/api/profile',      requireDevice, checkRateLimit('profile'), profileRouter)
app.use('/api/panel',        requireDevice, panelRouter)
app.use('/api/subscription', requireDevice, subscriptionRouter)
app.use('/api/device',       requireDevice, deviceRouter)

// ── Admin API ──────────────────────────────────────────────────────────────────
app.use('/admin', adminRouter)

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => { res.status(404).json({ error: 'not_found' }) })
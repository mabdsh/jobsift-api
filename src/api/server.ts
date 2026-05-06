import express, { Request, Response, NextFunction } from 'express'
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
import { trialRouter        } from '../routes/trialRouter'
import { deviceRouter       } from '../routes/deviceRouter'

export const app = express()

// ── Trust proxy ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1)

// ── Webhook — MUST come before express.json() ──────────────────────────────────
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
  res.json({ ok: true, service: 'rolevance-api' })
})

// ── API routes ─────────────────────────────────────────────────────────────────
// /api/score has no rate-limit middleware — job card scoring is unlimited for
// every tier. The router itself increments a per-job-card counter for analytics.
app.use('/api/score',        requireDevice,                            scoreRouter)
app.use('/api/analyze',      requireDevice, checkRateLimit('analyze'), analyzeRouter)
app.use('/api/profile',      requireDevice, checkRateLimit('profile'), profileRouter)
app.use('/api/panel',        requireDevice, panelRouter)
app.use('/api/subscription', requireDevice, subscriptionRouter)
app.use('/api/trial',        requireDevice, trialRouter)
app.use('/api/device',       requireDevice, deviceRouter)

// ── Admin API ──────────────────────────────────────────────────────────────────
app.use('/admin', adminRouter)

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' })
})

// ── Global error handler ───────────────────────────────────────────────────────
// Catches any error thrown by routes or middleware (sync or async in Express 5).
// Prevents stack traces from leaking to clients and ensures every uncaught
// error returns a clean JSON response rather than a silent 500.
// Must be registered LAST — after all routes and the 404 handler.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Unhandled]', err)
  const status = err?.status ?? err?.statusCode ?? 500
  res.status(status).json({
    error:   'internal_error',
    message: 'An unexpected error occurred. Please try again.',
  })
})
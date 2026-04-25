// JobSift — Subscription Status & Restore Routes
// Called by the extension on startup and when user restores their subscription.

import { Router, Request, Response } from 'express'
import {
  isSubscriptionsEnabled, getEffectiveTier,
  getUsageToday, getDeviceByEmail, db
} from '../db/database'

export const subscriptionRouter = Router()

// ── Daily limits reference ─────────────────────────────────────────────────────
const LIMITS = {
  free: { batch: 30,  analyze: 3,  profile: 5  },
  pro:  { batch: 300, analyze: 30, profile: 20 },
} as const

// ── GET /api/subscription/status ───────────────────────────────────────────────
// Called by the extension on startup. Response is cached locally for 1 hour.
// Returns everything the extension needs to decide what UI to show.
subscriptionRouter.get('/status', (req: Request, res: Response) => {
  const deviceId   = req.deviceId!
  const subsEnabled = isSubscriptionsEnabled()
  const tier        = subsEnabled ? getEffectiveTier(deviceId) : 'pro'
  const usage       = getUsageToday(deviceId)
  const device      = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(deviceId) as any

  res.json({
    tier,
    subscriptions_enabled:  subsEnabled,
    subscription_status:    device?.subscription_status  ?? null,
    subscription_ends_at:   device?.subscription_ends_at ?? null,
    limits: LIMITS[tier],
    usage_today: {
      batch:   usage.batch_calls,
      analyze: usage.analyze_calls,
      profile: usage.profile_calls,
    },
  })
})

// ── POST /api/subscription/restore ────────────────────────────────────────────
// User reinstalled the extension or is on a new device. They enter their email
// and we link their new device_id to their existing subscription.
subscriptionRouter.post('/restore', (req: Request, res: Response) => {
  const deviceId = req.deviceId!
  const { email } = req.body

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'invalid_email', message: 'A valid email address is required.' })
    return
  }

  const existing = getDeviceByEmail(email.toLowerCase().trim())

  if (!existing) {
    res.status(404).json({
      error:   'not_found',
      message: 'No subscription found for this email address.',
    })
    return
  }

  // Only restore if subscription is still valid (active, cancelled-but-not-expired, or past_due)
  const validStatuses = ['active', 'cancelled', 'past_due']
  if (!validStatuses.includes(existing.subscription_status ?? '')) {
    res.status(400).json({
      error:   'inactive_subscription',
      message: 'This subscription has expired. Please subscribe again.',
    })
    return
  }

  // If this is a different device, copy the subscription to the new device_id.
  // If same device, this is a no-op (already linked).
  if (existing.id !== deviceId) {
    db.prepare(`
      UPDATE devices SET
        email                = ?,
        tier                 = ?,
        tier_override        = NULL,
        subscription_id      = ?,
        subscription_status  = ?,
        subscription_ends_at = ?
      WHERE id = ?
    `).run(
      existing.email,
      existing.tier,
      existing.subscription_id,
      existing.subscription_status,
      existing.subscription_ends_at,
      deviceId
    )
  }

  const restoredTier = getEffectiveTier(deviceId)

  res.json({
    ok:      true,
    message: 'Subscription restored successfully.',
    tier:    restoredTier,
  })
})

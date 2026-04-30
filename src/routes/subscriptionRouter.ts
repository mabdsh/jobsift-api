// JobSift — Subscription Status & Restore Routes

import { Router, Request, Response } from 'express'
import {
  isSubscriptionsEnabled, getEffectiveTier,
  getUsageToday, getTodayPanelOpenCount,
  getDeviceByEmail, db
} from '../db/database'

export const subscriptionRouter = Router()

// ── Daily limits reference ─────────────────────────────────────────────────────
// trial and pro have null limits = unlimited.
// The extension uses null to know it should not show usage counters.
const LIMITS = {
  free:  { panel: 2,    profile: 1  },
  trial: { panel: null, profile: null },
  pro:   { panel: null, profile: null },
} as const

// ── GET /api/subscription/status ───────────────────────────────────────────────
subscriptionRouter.get('/status', (req: Request, res: Response) => {
  const deviceId    = req.deviceId!
  const subsEnabled = isSubscriptionsEnabled()
  const tier        = subsEnabled ? getEffectiveTier(deviceId) : 'pro'
  const usage       = getUsageToday(deviceId)
  const panelOpens  = getTodayPanelOpenCount(deviceId)
  const device      = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(deviceId) as any

  // Calculate trial days remaining for the extension to display
  let trialDaysLeft: number | null = null
  if (tier === 'trial' && device?.trial_started_at) {
    const trialEnd = new Date(
      new Date(device.trial_started_at).getTime() + 5 * 24 * 60 * 60 * 1000
    )
    trialDaysLeft = Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / 86400000))
  }

  const tierKey = tier as keyof typeof LIMITS
  const limits  = LIMITS[tierKey] ?? LIMITS.free

  res.json({
    tier,
    trial_days_left:        trialDaysLeft,
    subscriptions_enabled:  subsEnabled,
    subscription_status:    device?.subscription_status  ?? null,
    subscription_ends_at:   device?.subscription_ends_at ?? null,
    limits,
    usage_today: {
      panel:   panelOpens,
      profile: usage.profile_calls,
    },
  })
})

// ── POST /api/subscription/restore ────────────────────────────────────────────
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

  const validStatuses = ['active', 'cancelled', 'past_due']
  if (!validStatuses.includes(existing.subscription_status ?? '')) {
    res.status(400).json({
      error:   'inactive_subscription',
      message: 'This subscription has expired. Please subscribe again.',
    })
    return
  }

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
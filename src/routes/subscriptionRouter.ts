// Rolevance — Subscription Status & Restore Routes

import { Router, Request, Response } from 'express'
import {
  isSubscriptionsEnabled, getEffectiveTier,
  getUsageToday, getTodayPanelOpenCount,
  getDeviceByEmail, db
} from '../db/database'
import {
  TRIAL_DAYS, PANEL_LIMITS, CALL_LIMITS,
  TIER_COPY, PRICING
} from '../config/limits'

export const subscriptionRouter = Router()

// ── GET /api/subscription/status ───────────────────────────────────────────────
subscriptionRouter.get('/status', (req: Request, res: Response) => {
  const deviceId    = req.deviceId!
  const subsEnabled = isSubscriptionsEnabled()
  const tier        = subsEnabled ? getEffectiveTier(deviceId) : 'pro'
  const usage       = getUsageToday(deviceId)
  const panelOpens  = getTodayPanelOpenCount(deviceId)
  const device      = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(deviceId) as any

  let trialDaysLeft: number | null = null
  if (tier === 'trial' && device?.trial_started_at) {
    const trialEnd = new Date(
      new Date(device.trial_started_at).getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000
    )
    trialDaysLeft = Math.max(1, Math.ceil((trialEnd.getTime() - Date.now()) / 86400000))
  }

  // Build the limits object from the single source of truth.
  // panel comes from PANEL_LIMITS, API calls from CALL_LIMITS.
  const t = tier as keyof typeof PANEL_LIMITS
  const limits = {
    panel:   PANEL_LIMITS[t]          ?? null,
    analyze: CALL_LIMITS.analyze[t]   ?? null,
    profile: CALL_LIMITS.profile[t]   ?? null,
    score:   null,                       // unlimited for every tier
  }

  res.json({
    tier,

    // Trial state — `available` is what the panel/popup uses to gate the
    // "Start trial" CTA. Once a device has any trial_started_at value
    // (active OR expired), they can never start another.
    trial_activated:   !!device?.trial_started_at,
    trial_available:    !device?.trial_started_at,
    trial_days_left:    trialDaysLeft,
    trial_duration_days: TRIAL_DAYS,

    subscriptions_enabled: subsEnabled,
    subscription_status:   device?.subscription_status  ?? null,
    subscription_ends_at:  device?.subscription_ends_at ?? null,

    limits,
    usage_today: {
      panel:   panelOpens,
      analyze: usage.analyze_calls,
      profile: usage.profile_calls,
      scored:  usage.jobs_scored,        // analytics only — not rate-limited
    },

    // Tier copy + pricing — single source of truth lives in config/limits.ts.
    // The popup reads from here so price or feature changes need only one edit
    // and propagate to every install on next status fetch.
    tiers:   TIER_COPY,
    pricing: PRICING,
  })
})

// ── POST /api/subscription/restore ────────────────────────────────────────────
// Restores a subscription to a new device by email lookup.
// Invalidates the old device to prevent two devices sharing one subscription.
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
      message: 'This subscription has expired or is inactive. Please subscribe again.',
    })
    return
  }

  if (existing.id !== deviceId) {
    // Revoke old + apply new must be atomic. Without the transaction wrapper,
    // a crash between the two UPDATEs leaves the paying customer with a
    // revoked old device and nothing on the new one — a worst-case outcome
    // that's hard to recover from without manual DB intervention.
    const migrate = db.transaction(() => {
      // Revoke the old device — one active device per subscription
      db.prepare(`
        UPDATE devices SET
          tier                 = 'free',
          subscription_id      = NULL,
          subscription_status  = NULL,
          subscription_ends_at = NULL
        WHERE id = ?
      `).run(existing.id)

      // Apply subscription to the new device
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
    })
    migrate()
  }

  const restoredTier = getEffectiveTier(deviceId)

  res.json({
    ok:      true,
    message: 'Subscription restored successfully.',
    tier:    restoredTier,
  })
})
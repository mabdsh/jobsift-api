import { Request, Response, NextFunction } from 'express'
import {
  getUsageToday, incrementUsage, UsageType,
  isSubscriptionsEnabled, getEffectiveTier
} from '../db/database'

// ── Limits ────────────────────────────────────────────────────────────────────
// Only profile parsing is rate-limited here.
// Panel opens are gated separately via /api/panel/open + recordPanelOpen().
// Batch scoring and deep analysis have no per-device rate limit —
// the panel gate is the only enforcement mechanism for free users.
const FREE_PROFILE_LIMIT = 3
const PRO_PROFILE_LIMIT  = 20

function nextMidnightUTC(): string {
  const d = new Date()
  d.setUTCHours(24, 0, 0, 0)
  return d.toISOString()
}

export function checkRateLimit(type: UsageType) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const deviceId = req.deviceId
    if (!deviceId) { res.status(401).json({ error: 'unauthorized' }); return }

    // When subscriptions are disabled globally, everyone gets unlimited access
    const subsEnabled = isSubscriptionsEnabled()
    if (!subsEnabled) { incrementUsage(deviceId, type); next(); return }

    const tier = getEffectiveTier(deviceId)

    // Trial and Pro users have no limits on any endpoint
    if (tier === 'trial' || tier === 'pro') {
      incrementUsage(deviceId, type)
      next()
      return
    }

    // Free tier — only profile parsing is limited here
    if (type !== 'profile') {
      // batch and analyze: no per-device limit at this middleware layer
      incrementUsage(deviceId, type)
      next()
      return
    }

    const usage = getUsageToday(deviceId)
    const used  = usage.profile_calls
    const limit = FREE_PROFILE_LIMIT

    if (used >= limit) {
      res.status(429).json({
        error:        'rate_limit_exceeded',
        message:      `Daily profile parse limit (${limit}) reached. Upgrade to Pro for ${PRO_PROFILE_LIMIT} per day.`,
        limit,
        used,
        tier,
        needs_upgrade: true,
        reset_at:     nextMidnightUTC(),
      })
      return
    }

    incrementUsage(deviceId, type)
    next()
  }
}
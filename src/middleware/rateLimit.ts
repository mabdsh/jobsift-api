import { Request, Response, NextFunction } from 'express'
import {
  EffectiveTier,
  isSubscriptionsEnabled, getEffectiveTier, tryConsumeUsage, incrementUsage
} from '../db/database'
import { CALL_LIMITS, RateLimitedType } from '../config/limits'

// ── Limit resolution ──────────────────────────────────────────────────────────
// All numbers and copy live in src/config/limits.ts — never hardcode here.
// null = unlimited for that tier + type combination.
//
// Note: 'score' is intentionally NOT rate-limited — job card scoring is
// unlimited for every tier. Only 'analyze' and 'profile' flow through here.

function nextMidnightUTC(): string {
  const d = new Date()
  d.setUTCHours(24, 0, 0, 0)
  return d.toISOString()
}

function limitMessage(type: RateLimitedType, limit: number, tier: EffectiveTier = 'free'): string {
  const suffix = tier === 'trial'
    ? ` Resets at midnight UTC.`
    : ` Upgrade to Pro for unlimited access.`
  if (type === 'analyze') return `Daily analysis limit (${limit}) reached.${suffix}`
  return `Daily profile parse limit (${limit}) reached.${suffix}`
}

export function checkRateLimit(type: RateLimitedType) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const deviceId = req.deviceId
    if (!deviceId) { res.status(401).json({ error: 'unauthorized' }); return }

    // Subscriptions disabled globally → everyone is effectively Pro.
    // Still increment for analytics, but skip the limit check entirely.
    if (!isSubscriptionsEnabled()) {
      incrementUsage(deviceId, type)
      next()
      return
    }

    const tier = getEffectiveTier(deviceId)
    const limit: number | null =
      tier === 'free'  ? CALL_LIMITS[type].free  :
      tier === 'trial' ? CALL_LIMITS[type].trial :
                         CALL_LIMITS[type].pro

    // Atomic check + increment. Without this, two concurrent requests on a
    // free user's last allowed call can both observe used == limit-1 and both
    // increment, letting the user exceed their daily allowance.
    const result = tryConsumeUsage(deviceId, type, limit)

    if (!result.allowed) {
      res.status(429).json({
        error:         tier === 'trial' ? 'trial_daily_limit' : 'rate_limit_exceeded',
        message:       limitMessage(type, result.limit!, tier),
        limit:         result.limit,
        used:          result.used,
        tier,
        needs_upgrade: tier === 'free',
        reset_at:      nextMidnightUTC(),
      })
      return
    }

    next()
  }
}
import { Request, Response, NextFunction } from 'express'
import {
  getUsageToday, incrementUsage, UsageType, EffectiveTier,
  isSubscriptionsEnabled, getEffectiveTier
} from '../db/database'
import { CALL_LIMITS } from '../config/limits'

// ── Limit resolution ──────────────────────────────────────────────────────────
// All numbers live in src/config/limits.ts — never hardcode values here.
// null = unlimited for that tier + type combination.

function nextMidnightUTC(): string {
  const d = new Date()
  d.setUTCHours(24, 0, 0, 0)
  return d.toISOString()
}

function usageField(
  type: UsageType
): 'batch_calls' | 'analyze_calls' | 'profile_calls' {
  if (type === 'batch')   return 'batch_calls'
  if (type === 'analyze') return 'analyze_calls'
  return 'profile_calls'
}

function limitMessage(type: UsageType, limit: number, tier: EffectiveTier = 'free'): string {
  const suffix = tier === 'trial'
    ? ` Resets at midnight UTC.`
    : ` Upgrade to Pro for unlimited access.`
  if (type === 'batch')   return `Daily scoring limit (${limit} batches) reached.${suffix}`
  if (type === 'analyze') return `Daily analysis limit (${limit}) reached.${suffix}`
  return `Daily profile parse limit (${limit}) reached.${suffix}`
}

export function checkRateLimit(type: UsageType) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const deviceId = req.deviceId
    if (!deviceId) { res.status(401).json({ error: 'unauthorized' }); return }

    // Subscriptions disabled globally → everyone is effectively Pro
    if (!isSubscriptionsEnabled()) {
      incrementUsage(deviceId, type)
      next()
      return
    }

    const tier  = getEffectiveTier(deviceId)
    const limit: number | null =
      tier === 'free'  ? CALL_LIMITS[type].free  :
      tier === 'trial' ? CALL_LIMITS[type].trial :
                         CALL_LIMITS[type].pro

    // Unlimited — still increment for analytics
    if (limit === null) {
      incrementUsage(deviceId, type)
      next()
      return
    }

    const usage = getUsageToday(deviceId)
    const used  = usage[usageField(type)]

    if (used >= limit) {
      res.status(429).json({
        error:         tier === 'trial' ? 'trial_daily_limit' : 'rate_limit_exceeded',
        message:       limitMessage(type, limit, tier),
        limit,
        used,
        tier,
        needs_upgrade: tier === 'free',
        reset_at:      nextMidnightUTC(),
      })
      return
    }

    incrementUsage(deviceId, type)
    next()
  }
}
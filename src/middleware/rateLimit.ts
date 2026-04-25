import { Request, Response, NextFunction } from 'express'
import {
  getUsageToday, incrementUsage, UsageType,
  isSubscriptionsEnabled, getEffectiveTier
} from '../db/database'

// ── Tier limits ────────────────────────────────────────────────────────────────
// Free: conservative limits — enough to evaluate the tool, not enough for
//       a serious all-day job search session.
// Pro:  effectively unlimited for any realistic LinkedIn session.
const LIMITS = {
  free: { batch: 30,  analyze: 3,  profile: 5  },
  pro:  { batch: 300, analyze: 30, profile: 20 },
} as const

function nextMidnightUTC(): string {
  const d = new Date()
  d.setUTCHours(24, 0, 0, 0)
  return d.toISOString()
}

export function checkRateLimit(type: UsageType) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const deviceId = req.deviceId
    if (!deviceId) { res.status(401).json({ error: 'unauthorized' }); return }

    // When subscriptions are disabled globally, everyone gets Pro limits.
    // This is the state during the launch/free phase — one flag controls
    // the entire paywall without touching user records.
    const subsEnabled = isSubscriptionsEnabled()
    const tier        = subsEnabled ? getEffectiveTier(deviceId) : 'pro'
    const limit       = LIMITS[tier][type]

    const usage = getUsageToday(deviceId)
    const used  = usage[`${type}_calls` as keyof typeof usage] ?? 0

    if (used >= limit) {
      const needsUpgrade = subsEnabled && tier === 'free'
      res.status(429).json({
        error:        'rate_limit_exceeded',
        message:      needsUpgrade
          ? `Daily ${type} limit (${limit}) reached. Upgrade to Pro for ${LIMITS.pro[type]} per day.`
          : `Daily limit of ${limit} ${type} requests reached. Resets at midnight UTC.`,
        limit,
        used,
        tier,
        needs_upgrade: needsUpgrade,
        reset_at:     nextMidnightUTC(),
      })
      return
    }

    // Increment before the Groq call — a failed AI call still counts.
    // Prevents hammering the endpoint to consume quota for free via server errors.
    incrementUsage(deviceId, type)
    next()
  }
}

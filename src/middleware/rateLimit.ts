import { Request, Response, NextFunction } from 'express'
import {
  getUsageToday, incrementUsage, UsageType,
  isSubscriptionsEnabled, getEffectiveTier
} from '../db/database'

// ── Limits ────────────────────────────────────────────────────────────────────
//
// batch:   Primary Groq spend control for free users. 30 calls ≈ 750 jobs/day —
//          covers a serious job hunter scrolling 2–3 full pages. Pro/Trial get
//          null (unlimited) because the panel gate doesn't cap batch scoring.
//
// analyze: Set one above the panel gate (5/day) so legitimate free users never
//          see this limit — the panel gate blocks them at 5 panels first.
//          This is a backend-only abuse backstop against direct API calls that
//          bypass the panel gate entirely (e.g. someone who extracted the client
//          secret and is looping /api/analyze/job directly).
//          Pro/Trial: null (unlimited — matches unlimited panels).
//
// profile: User-facing limit shown in the popup. 3/day free, 20/day pro.
//          Previously pro was unlimited despite the upgrade page advertising 20 —
//          that inconsistency is now fixed.

// ── Tier limits ──────────────────────────────────────────────────────────────
//
// Free tier design (deliberate):
//   - batch:   30/day — unlimited badge scoring is our acquisition hook. Never limit.
//   - analyze: 0 — AI analysis is the core paid value. Free users see an upgrade teaser.
//              Backend blocks direct API calls that bypass the panel gate.
//   - profile: 1/day — enough to set up, creates urgency to upgrade for daily use.
//
// Pro/Trial: everything unlimited.

const LIMITS = {
  batch: {
    free: 30,
    pro:  null,
  },
  analyze: {
    free: 0,      // AI analysis completely locked on free — teaser shown instead
    pro:  null,
  },
  profile: {
    free: 1,      // 1/day: enough to onboard, creates upgrade friction
    pro:  null,
  },
} as const satisfies Record<UsageType, { free: number; pro: number | null }>

function nextMidnightUTC(): string {
  const d = new Date()
  d.setUTCHours(24, 0, 0, 0)
  return d.toISOString()
}

// Maps UsageType → the matching field name in UsageRow
function usageField(
  type: UsageType
): 'batch_calls' | 'analyze_calls' | 'profile_calls' {
  if (type === 'batch')   return 'batch_calls'
  if (type === 'analyze') return 'analyze_calls'
  return 'profile_calls'
}

function limitMessage(type: UsageType, limit: number): string {
  if (type === 'batch')
    return `Daily scoring limit (${limit} batches) reached. Upgrade to Pro for unlimited scoring.`
  if (type === 'analyze')
    return `Daily analysis limit (${limit}) reached. Upgrade to Pro for unlimited analysis.`
  return `Daily profile parse limit (${limit}) reached. Upgrade to Pro for 20 per day.`
}

export function checkRateLimit(type: UsageType) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const deviceId = req.deviceId
    if (!deviceId) { res.status(401).json({ error: 'unauthorized' }); return }

    // Subscriptions disabled globally → everyone is effectively Pro, no limits
    if (!isSubscriptionsEnabled()) {
      incrementUsage(deviceId, type)
      next()
      return
    }

    const tier  = getEffectiveTier(deviceId)
    const isFree = tier === 'free'

    // ── Determine applicable limit ─────────────────────────────────────────
    // null means unlimited for this tier+type combination
    const limit: number | null = isFree
      ? LIMITS[type].free
      : LIMITS[type].pro    // pro and trial share the same pro limits

    if (limit === null) {
      // Unlimited — still increment for analytics, then pass through
      incrementUsage(deviceId, type)
      next()
      return
    }

    // ── Check daily usage against limit ────────────────────────────────────
    const usage = getUsageToday(deviceId)
    const used  = usage[usageField(type)]

    if (used >= limit) {
      res.status(429).json({
        error:         'rate_limit_exceeded',
        message:       limitMessage(type, limit),
        limit,
        used,
        tier,
        needs_upgrade: isFree,   // only prompt upgrade for free users
        reset_at:      nextMidnightUTC(),
      })
      return
    }

    incrementUsage(deviceId, type)
    next()
  }
}
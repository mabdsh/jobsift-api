import { Request, Response, NextFunction } from 'express'
import { getUsageToday, incrementUsage, UsageType } from '../db/database'

// Daily limits per device — conservative for a free product
const LIMITS: Record<UsageType, number> = {
  batch:   150,  // one full LinkedIn page per batch — users browse ~3-5 pages/session
  analyze:  25,  // panel click — more expensive, less frequent
  profile:  10,  // auto-fill — users rarely redo this more than once or twice
}

// ISO timestamp of next UTC midnight — shown in the 429 so the extension
// can display a "resets at X" message instead of a generic error
function nextMidnightUTC(): string {
  const d = new Date()
  d.setUTCHours(24, 0, 0, 0)
  return d.toISOString()
}

export function checkRateLimit(type: UsageType) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const deviceId = req.deviceId
    if (!deviceId) {
      // Should never reach here — requireDevice runs first
      res.status(401).json({ error: 'unauthorized' })
      return
    }

    const usage = getUsageToday(deviceId)
    const field = `${type}_calls` as keyof typeof usage
    const used  = usage[field] ?? 0
    const limit = LIMITS[type]

    if (used >= limit) {
      res.status(429).json({
        error:    'rate_limit_exceeded',
        message:  `Daily limit of ${limit} ${type} requests reached. Resets at midnight UTC.`,
        limit,
        used,
        reset_at: nextMidnightUTC(),
      })
      return
    }

    // Increment before the Groq call — failed Groq requests still count.
    // This prevents someone from hammering the endpoint to consume quota for free
    // by triggering server errors.
    incrementUsage(deviceId, type)
    next()
  }
}

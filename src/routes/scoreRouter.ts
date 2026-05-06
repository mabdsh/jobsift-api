import { Router, Request, Response } from 'express'
import { batchScoreJobs }            from '../services/groqClient'
import { logRequest, incrementUsage } from '../db/database'

export const scoreRouter = Router()

scoreRouter.post('/batch', async (req: Request, res: Response) => {
  const start = Date.now()
  const { profile, jobs } = req.body

  if (!profile || !Array.isArray(jobs) || jobs.length === 0) {
    res.status(400).json({
      error:   'invalid_input',
      message: 'profile object and non-empty jobs array are required',
    })
    return
  }

  if (jobs.length > 50) {
    res.status(400).json({
      error:   'too_many_jobs',
      message: 'Maximum 50 jobs per batch — LinkedIn shows ~25 per page',
    })
    return
  }

  // Silently truncate rawText on each job — the extension already self-limits
  // to 4000 chars, but this guards against direct API callers or future changes.
  const sanitizedJobs = jobs.map((j: any) => ({
    ...j,
    rawText: typeof j.rawText === 'string' ? j.rawText.slice(0, 4000) : '',
  }))

  // Score is unlimited for all tiers, so there's no rate-limit middleware.
  // We still increment the per-job-card counter for analytics — this is the
  // "1.2M jobs scored this week" metric in the admin panel.
  if (req.deviceId) {
    incrementUsage(req.deviceId, 'score', sanitizedJobs.length)
  }

  try {
    const results = await batchScoreJobs(profile, sanitizedJobs)

    logRequest({
      deviceId:  req.deviceId ?? null,
      endpoint:  '/api/score/batch',
      latencyMs: Date.now() - start,
      status:    200,
    })

    res.json({ ok: true, results })
  } catch (err: any) {
    const isParseError = err?.name === 'GroqParseError'
    const status       = err?.status === 429 ? 429 : 500

    logRequest({
      deviceId:  req.deviceId ?? null,
      endpoint:  '/api/score/batch',
      latencyMs: Date.now() - start,
      status,
      error:     isParseError ? 'GROQ_PARSE_ERROR' : (err?.message ?? 'unknown'),
    })

    res.status(status).json({
      ok:    false,
      error: status === 429
        ? 'GROQ_RATE_LIMIT'
        : isParseError ? 'GROQ_PARSE_ERROR' : 'SERVER_ERROR',
      message: status === 429
        ? 'Groq rate limit hit — rule-based scoring applied'
        : isParseError
          ? 'AI response malformed — rule-based scoring applied'
          : 'Scoring service temporarily unavailable',
    })
  }
})
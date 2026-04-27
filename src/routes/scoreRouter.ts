import { Router, Request, Response } from 'express'
import { batchScoreJobs }            from '../services/groqClient'
import { logRequest }                from '../db/database'

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

  try {
    const results = await batchScoreJobs(profile, jobs)

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
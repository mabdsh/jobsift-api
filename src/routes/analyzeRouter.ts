import { Router, Request, Response } from 'express'
import { analyzeJob }                from '../services/groqClient'
import { logRequest }                from '../db/database'

export const analyzeRouter = Router()

analyzeRouter.post('/job', async (req: Request, res: Response) => {
  const start = Date.now()

  const { profile, jobData, fullDescription } = req.body

  if (!profile || !jobData) {
    res.status(400).json({
      error:   'invalid_input',
      message: 'profile and jobData are required',
    })
    return
  }

  try {
    const result = await analyzeJob(profile, jobData, fullDescription ?? '')

    logRequest({
      deviceId:  req.deviceId ?? null,
      endpoint:  '/api/analyze/job',
      latencyMs: Date.now() - start,
      status:    200,
    })

    res.json({ ok: true, result })
  } catch (err: any) {
    const status = err?.status === 429 ? 429 : 500

    logRequest({
      deviceId:  req.deviceId ?? null,
      endpoint:  '/api/analyze/job',
      latencyMs: Date.now() - start,
      status,
      error:     err?.message ?? 'unknown',
    })

    res.status(status).json({
      ok:      false,
      error:   status === 429 ? 'GROQ_RATE_LIMIT' : 'SERVER_ERROR',
      message: status === 429
        ? 'Analysis service busy — try again shortly'
        : 'Deep analysis temporarily unavailable',
    })
  }
})

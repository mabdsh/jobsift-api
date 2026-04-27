import { Router, Request, Response } from 'express'
import { parseProfile }              from '../services/groqClient'
import { logRequest }                from '../db/database'

export const profileRouter = Router()

profileRouter.post('/parse', async (req: Request, res: Response) => {
  const start = Date.now()
  const { text } = req.body

  if (!text || typeof text !== 'string' || text.trim().length < 20) {
    res.status(400).json({
      error:   'invalid_input',
      message: 'text must be a string of at least 20 characters',
    })
    return
  }

  if (text.length > 2000) {
    res.status(400).json({
      error:        'text_too_long',
      message:      'text must be 2000 characters or less',
      max_length:      2000,
      received_length: text.length,
    })
    return
  }

  try {
    const result = await parseProfile(text.trim())

    logRequest({
      deviceId:  req.deviceId ?? null,
      endpoint:  '/api/profile/parse',
      latencyMs: Date.now() - start,
      status:    200,
    })

    res.json({ ok: true, result })
  } catch (err: any) {
    const isParseError = err?.name === 'GroqParseError'
    const status       = err?.status === 429 ? 429 : 500

    logRequest({
      deviceId:  req.deviceId ?? null,
      endpoint:  '/api/profile/parse',
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
        ? 'Profile parsing busy — try again shortly'
        : isParseError
          ? 'AI response malformed — profile parsing temporarily unavailable'
          : 'Profile parsing temporarily unavailable',
    })
  }
})
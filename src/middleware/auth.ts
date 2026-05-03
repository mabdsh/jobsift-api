import { Request, Response, NextFunction } from 'express'
import crypto      from 'crypto'
import { upsertDevice } from '../db/database'

// Standard UUID v4 pattern
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

declare global {
  namespace Express {
    interface Request {
      deviceId?: string
    }
  }
}

// Timing-safe string comparison — prevents brute-forcing the client secret
// one character at a time via response-time measurement.
function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  // Buffers must be the same length for timingSafeEqual.
  // If lengths differ we still return false, but we run the comparison
  // anyway on equal-length slices so the timing stays consistent.
  if (ab.length !== bb.length) {
    // Run a dummy comparison to keep timing similar
    crypto.timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1))
    return false
  }
  return crypto.timingSafeEqual(ab, bb)
}

export function requireDevice(
  req:  Request,
  res:  Response,
  next: NextFunction
): void {
  // 1. Client secret — quick check before any DB work
  const secret = req.headers['x-client-secret'] as string | undefined
  if (!safeEqual(secret ?? '', process.env.CLIENT_SECRET ?? '')) {
    res.status(401).json({
      error:   'unauthorized',
      message: 'Invalid or missing X-Client-Secret header',
    })
    return
  }

  // 2. Device ID — must be a valid UUID v4
  const deviceId = req.headers['x-device-id'] as string | undefined
  if (!deviceId || !UUID_REGEX.test(deviceId)) {
    res.status(401).json({
      error:   'unauthorized',
      message: 'Valid UUID v4 required in X-Device-ID header',
    })
    return
  }

  upsertDevice(deviceId)
  req.deviceId = deviceId
  next()
}
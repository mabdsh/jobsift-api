import { Request, Response, NextFunction } from 'express'
import { upsertDevice } from '../db/database'

// Standard UUID v4 pattern
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Augment Express Request so every downstream handler gets typed deviceId
declare global {
  namespace Express {
    interface Request {
      deviceId?: string
    }
  }
}

export function requireDevice(
  req:  Request,
  res:  Response,
  next: NextFunction
): void {
  // 1. Client secret — quick check before any DB work
  const secret = req.headers['x-client-secret'] as string | undefined
  if (!secret || secret !== process.env.CLIENT_SECRET) {
    res.status(401).json({
      error:   'unauthorized',
      message: 'Invalid or missing X-Client-Secret header'
    })
    return
  }

  // 2. Device ID — must be a valid UUID v4
  const deviceId = req.headers['x-device-id'] as string | undefined
  if (!deviceId || !UUID_REGEX.test(deviceId)) {
    res.status(401).json({
      error:   'unauthorized',
      message: 'Valid UUID required in X-Device-ID header'
    })
    return
  }

  // Register on first seen, update last_seen on every request
  upsertDevice(deviceId)

  req.deviceId = deviceId
  next()
}

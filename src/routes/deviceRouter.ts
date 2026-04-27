// JobSift — Device Email Endpoint
// Called by the popup when a user optionally provides their email address.
// Stores it on the device record so we can send trial-end notifications
// and support subscription restore by email.

import { Router, Request, Response } from 'express'
import { db }                        from '../db/database'

export const deviceRouter = Router()

deviceRouter.post('/email', (req: Request, res: Response) => {
  const deviceId = req.deviceId!
  const raw      = req.body.email

  if (!raw || typeof raw !== 'string') {
    res.status(400).json({ error: 'invalid_email', message: 'Email is required.' })
    return
  }

  const email = raw.toLowerCase().trim()

  // Basic format validation — not RFC-exhaustive, just catches obvious garbage
  if (!email.includes('@') || !email.includes('.') || email.length > 254) {
    res.status(400).json({ error: 'invalid_email', message: 'Enter a valid email address.' })
    return
  }

  try {
    db.prepare(`UPDATE devices SET email = ? WHERE id = ?`).run(email, deviceId)
    console.log(`[Device] Email saved for device ${deviceId.substring(0, 8)}…`)
    res.json({ ok: true, message: 'Email saved.' })
  } catch (err: any) {
    console.error('[Device] Failed to save email:', err)
    res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: 'Failed to save email — try again.' })
  }
})

// Rolevance — Trial Activation Endpoint
// Called by the extension popup when a user enters their email to start their
// 7-day free trial. Sets trial_started_at and stores the email.
//
// Returns:
//   ok: true,  already_active: false  — trial freshly activated
//   ok: true,  already_active: true   — trial was already running on this device
//   ok: false, error: 'TRIAL_USED'    — this email already has a trial on another device

import { Router, Request, Response } from 'express'
import { activateTrial }             from '../db/database'

export const trialRouter = Router()

// Stricter than the old includes('@') + includes('.') check.
// Not RFC-exhaustive but catches all realistic garbage inputs.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

trialRouter.post('/activate', (req: Request, res: Response) => {
  const deviceId = req.deviceId!
  const raw      = req.body.email

  if (!raw || typeof raw !== 'string') {
    res.status(400).json({ error: 'invalid_email', message: 'Email is required.' })
    return
  }

  const email = raw.toLowerCase().trim()

  if (!EMAIL_RE.test(email) || email.length > 254) {
    res.status(400).json({ error: 'invalid_email', message: 'Enter a valid email address.' })
    return
  }

  try {
    const result = activateTrial(deviceId, email)

    if (result === 'already_active') {
      console.log(`[Trial] Device ${deviceId.substring(0, 8)}… already had trial — ${email}`)
      res.json({
        ok:             true,
        already_active: true,
        message:        'Trial already active.',
      })
      return
    }

    if (result === 'email_used') {
      // Return a generic message — don't confirm whether the email is in our system
      console.log(`[Trial] Email already used for trial — blocked: ${email}`)
      res.status(400).json({
        ok:      false,
        error:   'TRIAL_USED',
        message: 'A trial has already been used with this email address.',
      })
      return
    }

    // result === 'activated'
    console.log(`[Trial] Device ${deviceId.substring(0, 8)}… activated trial — ${email}`)
    res.json({
      ok:             true,
      already_active: false,
      message:        'Trial activated. Enjoy your 7 days!',
    })
  } catch (err: any) {
    console.error('[Trial] Activation failed:', err)
    res.status(500).json({
      ok:      false,
      error:   'SERVER_ERROR',
      message: 'Could not activate trial — please try again.',
    })
  }
})
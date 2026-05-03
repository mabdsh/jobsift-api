// Rolevance — Panel Open Gate
// Called by the extension before opening any job panel.
// Always returns HTTP 200 — the extension reads the `allowed` field,
// not the HTTP status code, to decide what to show.
// Failing at the HTTP level (5xx) means the extension gets no response
// and falls back to opening the panel anyway (fail-open is intentional).

import { Router, Request, Response } from 'express'
import { recordPanelOpen }           from '../db/database'

export const panelRouter = Router()

// LinkedIn/Indeed job IDs are at most ~20 chars. Cap at 64 as a safe ceiling
// to prevent a caller sending a multi-MB string that gets written to panel_opens
// and read back on every panel-count query.
const MAX_JOB_ID_LENGTH = 64

panelRouter.post('/open', (req: Request, res: Response) => {
  const deviceId = req.deviceId!
  const jobId    = (typeof req.body.jobId === 'string' ? req.body.jobId : '')
    .trim()
    .slice(0, MAX_JOB_ID_LENGTH)

  try {
    const result = recordPanelOpen(deviceId, jobId)
    res.json(result)
  } catch (err: any) {
    console.error('[Panel] recordPanelOpen error:', err)
    // Fail open — a server-side error must never block a user from their panel
    res.json({
      allowed:       true,
      alreadyOpened: false,
      usedToday:     0,
      limit:         null,
      trial:         false,
      trialDaysLeft: null,
      resetAt:       null,
      needs_upgrade: false,
    })
  }
})
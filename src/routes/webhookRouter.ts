// Rolevance — LemonSqueezy Webhook Handler
// Receives subscription lifecycle events and updates device tier accordingly.
//
// IMPORTANT: This route must receive the RAW request body (Buffer), not parsed JSON.
// In server.ts it is registered BEFORE express.json() with express.raw().
// The raw body is required to verify the HMAC-SHA256 signature.

import { Router, Request, Response } from 'express'
import crypto                         from 'crypto'
import { updateDeviceSubscription }   from '../db/database'

export const webhookRouter = Router()

// Maps a LemonSqueezy subscription status to the tier stored in our database.
// This is the single source of truth for status → tier — used by subscription_updated
// which can arrive with any status. The dedicated event handlers (cancelled,
// expired, payment_failed) call updateDeviceSubscription directly with their known
// tier, but subscription_updated needs to handle all cases because LemonSqueezy can
// fire it alongside any lifecycle event, sometimes after the dedicated handler.
//
// Critical: past_due and cancelled must stay 'pro' so getEffectiveTier() can enforce
// the grace period logic that checks device.tier === 'pro' before inspecting
// subscription_status. Setting them to 'free' here would skip that check entirely.
function tierForStatus(status: string | undefined): 'pro' | 'free' {
  switch (status) {
    case 'active':    return 'pro'   // paying and current
    case 'past_due':  return 'pro'   // payment failed, still in grace period
    case 'cancelled': return 'pro'   // paid through subscription_ends_at
    case 'expired':   return 'free'  // billing period ended after cancellation
    case 'paused':    return 'free'  // subscription on hold
    default:          return 'free'  // unknown status — safe default
  }
}

// Verify X-Signature header using HMAC-SHA256 of the raw body.
// Uses timingSafeEqual to prevent timing attacks.
function verifySignature(rawBody: Buffer, signature: string): boolean {
  const secret = process.env.LEMONSQUEEZY_SIGNING_SECRET
  if (!secret || !signature) return false
  try {
    const hmac     = crypto.createHmac('sha256', secret)
    const expected = hmac.update(rawBody).digest('hex')
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    )
  } catch { return false }
}

webhookRouter.post('/', (req: Request, res: Response) => {
  const signature = req.headers['x-signature'] as string | undefined
  const rawBody   = req.body as Buffer

  if (!verifySignature(rawBody, signature ?? '')) {
    console.warn('LemonSqueezy webhook: invalid signature')
    res.status(401).json({ error: 'invalid_signature' })
    return
  }

  let payload: any
  try {
    payload = JSON.parse(rawBody.toString('utf8'))
  } catch {
    res.status(400).json({ error: 'invalid_json' })
    return
  }

  const eventName = payload?.meta?.event_name   as string | undefined
  const customData = payload?.meta?.custom_data as Record<string, string> | undefined
  const attrs      = payload?.data?.attributes  as Record<string, any>    | undefined
  const subId      = String(payload?.data?.id   ?? '')

  // device_id is passed as custom data when the checkout is opened
  const deviceId = customData?.device_id
  const email    = attrs?.user_email ?? null

  console.log(`LemonSqueezy event: ${eventName} | device: ${deviceId ?? 'unknown'} | sub: ${subId}`)

  if (!deviceId) {
    // No device_id means this checkout didn't come from our extension.
    // Acknowledge but take no action.
    res.json({ received: true, action: 'ignored_no_device_id' })
    return
  }

  switch (eventName) {
    // Subscription successfully started or updated (e.g. plan change)
    case 'subscription_created':
    case 'subscription_updated':
      updateDeviceSubscription({
        deviceId,
        email,
        subscriptionId: subId,
        status: attrs?.status ?? 'active',
        tier:   tierForStatus(attrs?.status),
        endsAt: attrs?.ends_at ?? null,
      })
      break

    // User cancelled — stays Pro until billing period ends (ends_at is set)
    case 'subscription_cancelled':
      updateDeviceSubscription({
        deviceId,
        email,
        subscriptionId: subId,
        status: 'cancelled',
        tier:   'pro',          // still paid through period end
        endsAt: attrs?.ends_at ?? null,
      })
      break

    // Billing period ended after cancellation — downgrade to free
    case 'subscription_expired':
      updateDeviceSubscription({
        deviceId,
        email,
        subscriptionId: subId,
        status: 'expired',
        tier:   'free',
        endsAt: null,
      })
      break

    // Payment failed — give a grace period, still Pro
    case 'subscription_payment_failed':
      updateDeviceSubscription({
        deviceId,
        email,
        subscriptionId: subId,
        status: 'past_due',
        tier:   'pro',
        endsAt: null,
      })
      break

    default:
      // Unknown event — acknowledge without error so LemonSqueezy doesn't retry
      break
  }

  res.json({ received: true })
})
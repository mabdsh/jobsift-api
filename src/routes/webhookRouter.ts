// JobSift — LemonSqueezy Webhook Handler
// Receives subscription lifecycle events and updates device tier accordingly.
//
// IMPORTANT: This route must receive the RAW request body (Buffer), not parsed JSON.
// In server.ts it is registered BEFORE express.json() with express.raw().
// The raw body is required to verify the HMAC-SHA256 signature.

import { Router, Request, Response } from 'express'
import crypto                         from 'crypto'
import { updateDeviceSubscription }   from '../db/database'

export const webhookRouter = Router()

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
        tier:   attrs?.status === 'active' ? 'pro' : 'free',
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

import express  from 'express'
import cors     from 'cors'
import path     from 'path'
import crypto   from 'crypto'

import { requireDevice  } from '../middleware/auth'
import { checkRateLimit } from '../middleware/rateLimit'

import { scoreRouter        } from '../routes/scoreRouter'
import { analyzeRouter      } from '../routes/analyzeRouter'
import { profileRouter      } from '../routes/profileRouter'
import { panelRouter        } from '../routes/panelRouter'
import { adminRouter        } from '../routes/adminRouter'
import { webhookRouter      } from '../routes/webhookRouter'
import { subscriptionRouter } from '../routes/subscriptionRouter'
import { deviceRouter } from '../routes/deviceRouter'

export const app = express()

// ── Trust proxy ────────────────────────────────────────────────────────────────
// Tells Express to trust X-Forwarded-For / X-Real-IP set by Nginx.
// Without this, req.ip is always 127.0.0.1 (Nginx loopback).
app.set('trust proxy', 1)

// ── Webhook — MUST come before express.json() ──────────────────────────────────
app.use(
  '/webhook/lemonsqueezy',
  express.raw({ type: 'application/json' }),
  webhookRouter
)

// ── Standard middleware ────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }))

app.use(cors({
  origin: (origin, cb) => {
    if (
      !origin ||
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('http://localhost')
    ) {
      cb(null, true)
    } else {
      cb(new Error('Not allowed by CORS'))
    }
  },
  allowedHeaders: [
    'Content-Type', 'X-Device-ID', 'X-Client-Secret', 'X-Admin-Secret',
  ],
}))

// ── Admin panel static files ───────────────────────────────────────────────────
app.use('/admin-panel', express.static(path.join(process.cwd(), 'public')))
app.get('/admin-panel', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'))
})

// ── Upgrade / checkout page ────────────────────────────────────────────────────
app.get('/upgrade', (req, res) => {
  const deviceId  = (req.query.device as string ?? '').trim()
  const variantId = process.env.LEMONSQUEEZY_VARIANT_ID      ?? ''
  const store     = process.env.LEMONSQUEEZY_STORE_SUBDOMAIN ?? ''

  if (!deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
    res.status(400).send('Invalid request — missing device ID.')
    return
  }

  const checkoutUrl = variantId && store
    ? `https://${store}.lemonsqueezy.com/checkout/buy/${variantId}?checkout[custom][device_id]=${deviceId}`
    : '#not-configured'

  const notConfigured = !variantId || !store

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upgrade to JobSift Pro</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#F3F5F8;color:#111827;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;border:1px solid #E2E6EE;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:440px;width:100%;overflow:hidden}
.card-top{background:linear-gradient(135deg,#2455E8 0%,#5B7FFF 100%);padding:32px;text-align:center;color:#fff}
.logo{display:inline-flex;align-items:center;gap:10px;margin-bottom:20px}
.logo-mark{width:36px;height:36px;border-radius:9px;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.3);display:flex;align-items:center;justify-content:center}
.logo-name{font-size:20px;font-weight:700}
.card-top h1{font-size:26px;font-weight:700;letter-spacing:-.4px;margin-bottom:6px}
.card-top p{font-size:15px;opacity:.85;line-height:1.5}
.price{font-size:42px;font-weight:800;letter-spacing:-1px;margin:18px 0 4px}
.price span{font-size:18px;font-weight:500;opacity:.8}
.card-body{padding:28px}
.features{list-style:none;display:flex;flex-direction:column;gap:10px;margin-bottom:24px}
.features li{display:flex;align-items:flex-start;gap:10px;font-size:14px;color:#374151}
.check{width:20px;height:20px;border-radius:50%;background:#ECFDF5;border:1px solid #A7F3D0;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.check svg{color:#059669}
.free-row{display:flex;justify-content:space-between;padding:10px 14px;background:#F8F9FB;border-radius:8px;border:1px solid #E2E6EE;font-size:13px;color:#6B7280;margin-bottom:8px}
.subscribe-btn{width:100%;height:48px;background:linear-gradient(135deg,#2455E8,#5B7FFF);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif;transition:all .15s;box-shadow:0 2px 8px rgba(36,85,232,.3)}
.subscribe-btn:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(36,85,232,.4)}
.subscribe-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.fine-print{text-align:center;font-size:11.5px;color:#9CA3AF;margin-top:12px;line-height:1.5}
.warning{background:#FEF3C7;border:1px solid #FCD34D;border-radius:8px;padding:12px 14px;font-size:13px;color:#92400E;margin-bottom:16px}
</style>
</head>
<body>
<div class="card">
  <div class="card-top">
    <div class="logo">
      <div class="logo-mark">
        <svg viewBox="0 0 16 16" fill="none" width="16" height="16">
          <path d="M3 8.5l3.5 3.5 6.5-7" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <span class="logo-name">JobSift</span>
    </div>
    <h1>Upgrade to Pro</h1>
    <p>Find the right roles faster with unlimited AI-powered job scoring</p>
    <div class="price">$7<span>/month</span></div>
  </div>
  <div class="card-body">
    ${notConfigured ? '<div class="warning">⚠️ Checkout not configured yet — set LEMONSQUEEZY_VARIANT_ID and LEMONSQUEEZY_STORE_SUBDOMAIN in your .env file.</div>' : ''}
    <ul class="features">
      <li>
        <div class="check"><svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div><strong>Unlimited job panels</strong> — open every job's full breakdown, no daily cap</div>
      </li>
      <li>
        <div class="check"><svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div><strong>Unlimited AI deep analysis</strong> — full job description evaluation on every panel</div>
      </li>
      <li>
        <div class="check"><svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div><strong>20 auto-fill parses per day</strong> — update your profile anytime</div>
      </li>
      <li>
        <div class="check"><svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div><strong>Cancel anytime</strong> — no contracts, no commitments</div>
      </li>
    </ul>
    <div class="free-row"><span>Free tier includes</span><span>5 panels · 3 parses/day · 7-day full trial</span></div>
    <button class="subscribe-btn" id="subscribeBtn" onclick="goCheckout()" ${notConfigured ? 'disabled' : ''}>
      Subscribe — $7/month
    </button>
    <p class="fine-print">Powered by LemonSqueezy · Secure payment · Cancel anytime from your email</p>
  </div>
</div>
<script>
function goCheckout() {
  const btn = document.getElementById('subscribeBtn');
  btn.textContent = 'Redirecting to checkout…';
  btn.disabled = true;
  window.location.href = '${checkoutUrl}';
}
</script>
</body>
</html>`)
})

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'jobsift-api' })
})

// ── API routes ─────────────────────────────────────────────────────────────────
// Batch scoring:  no per-device rate limit — panel gate is the only free-tier wall
// Deep analysis:  no per-device rate limit — only reachable when a panel is allowed open
// Profile parse:  rate limited (3 free / 20 pro per day)
// Panel open:     gated inside panelRouter via recordPanelOpen()
app.use('/api/score',        requireDevice, scoreRouter)
app.use('/api/analyze',      requireDevice, analyzeRouter)
app.use('/api/profile',      requireDevice, checkRateLimit('profile'), profileRouter)
app.use('/api/panel',        requireDevice, panelRouter)
app.use('/api/subscription', requireDevice, subscriptionRouter)
app.use('/api/device',       requireDevice, deviceRouter)

// ── Admin API ──────────────────────────────────────────────────────────────────
app.use('/admin', adminRouter)

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => { res.status(404).json({ error: 'not_found' }) })
// Rolevance — Single source of truth for tier limits, pricing, and copy.
// Anywhere you want to change a number or a customer-facing string, change it here.
// Never define limit numbers, prices, or tier descriptions anywhere else.
//
// Imported by: db/database.ts, middleware/rateLimit.ts,
//              routes/subscriptionRouter.ts, routes/webhookRouter.ts
//
// The /api/subscription/status endpoint exposes everything below to the
// extension popup so the UI never hardcodes prices or limit numbers either.

// ── Tier definitions ─────────────────────────────────────────────────────────

export type Tier = 'free' | 'trial' | 'pro'

// Job card scores are unlimited for everyone — we still track the count for
// analytics, but there's no per-tier limit. They are deliberately absent here.
//
// Each entry below maps directly to a UsageType (see below). null = unlimited.
export const LIMITS = {
  free:  { panel: 3,    analyze: 3,    profile: 1    },
  trial: { panel: 10,   analyze: 10,   profile: 3    },
  pro:   { panel: null, analyze: null, profile: null },
} as const

// Used by recordPanelOpen() in database.ts
export const PANEL_LIMITS = {
  free:  LIMITS.free.panel,
  trial: LIMITS.trial.panel,
  pro:   LIMITS.pro.panel,
} as const

// Used by checkRateLimit() middleware. `score` is intentionally not in this
// object — score is unlimited for all tiers, just tracked for analytics.
export const CALL_LIMITS = {
  analyze: { free: LIMITS.free.analyze, trial: LIMITS.trial.analyze, pro: LIMITS.pro.analyze },
  profile: { free: LIMITS.free.profile, trial: LIMITS.trial.profile, pro: LIMITS.pro.profile },
} as const

// All tracked usage types. `score` is included for incrementUsage() but never
// passed to checkRateLimit() since it's not gated.
export type UsageType        = 'score' | 'analyze' | 'profile'
export type RateLimitedType  = Exclude<UsageType, 'score'>

// ── Trial ────────────────────────────────────────────────────────────────────

export const TRIAL_DAYS = 7

// ── Subscription lifecycle ───────────────────────────────────────────────────
//
// past_due = LemonSqueezy is retrying a failed payment. Customers in this state
// keep Pro access for PAST_DUE_GRACE_DAYS days from when the failure first
// occurred, after which they're downgraded to free. LemonSqueezy retries for
// ~16 days before giving up; 7 days protects revenue without being overly
// punitive to customers whose card is briefly declined.
//
// Enforced both in real-time (getEffectiveTier) and via the hourly safety-net
// job (expireStaleSubscriptions) — so even if a customer never opens the
// extension after the grace expires, the downgrade still happens.

export const PAST_DUE_GRACE_DAYS = 7

// ── Pricing ──────────────────────────────────────────────────────────────────

export const PRICING = {
  monthly_usd:           9,
  yearly_usd:            84,
  // Display strings — keep in sync with monthly/yearly above.
  monthly_label:         '$9/month',
  yearly_label:          '$84/year',
  yearly_equivalent:     '$7/month, billed annually',
  yearly_savings_label:  'Save 22% · 2+ months free',
} as const

// ── User-facing copy ─────────────────────────────────────────────────────────
//
// The popup reads this from /api/subscription/status — never hardcoded in
// the extension. When you change a price, a feature, or the trial length,
// this is the only place that needs an edit.

export const TIER_COPY = {
  free: {
    name:     'Free',
    headline: 'Job scoring on every card you see',
    bullets: [
      'Unlimited job card scores',
      `${LIMITS.free.panel} detailed panels per day`,
      `${LIMITS.free.analyze} AI coaching analyses per day`,
      `${LIMITS.free.profile} profile parse per day`,
    ],
  },
  trial: {
    name:          'Free trial',
    headline:      `${TRIAL_DAYS} days of full Pro access — no card required`,
    duration_days: TRIAL_DAYS,
    bullets: [
      'Unlimited job card scores',
      `${LIMITS.trial.panel} detailed panels per day`,
      `${LIMITS.trial.analyze} AI coaching analyses per day`,
      `${LIMITS.trial.profile} profile parses per day`,
    ],
  },
  pro: {
    name:     'Pro',
    headline: 'Unlimited everything — for serious job seekers',
    pricing:  PRICING,
    bullets: [
      'Unlimited job card scores',
      'Unlimited detailed panels',
      'Unlimited AI coaching analyses',
      'Unlimited profile parses',
      'Priority support',
    ],
  },
} as const
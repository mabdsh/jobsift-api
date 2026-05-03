// Rolevance — Central limits configuration
// This is the single source of truth for every tier limit in the system.
// Imported by: database.ts, rateLimit.ts, subscriptionRouter.ts
// Never define limit numbers anywhere else.

export const TRIAL_DAYS = 7

// Panel opens — gated in database.ts via recordPanelOpen()
export const PANEL_LIMITS = {
  free:  3,
  trial: 10,
  pro:   null,
} as const

// API call limits — enforced by rateLimit.ts middleware
// null = unlimited for that tier
export const CALL_LIMITS = {
  batch:   { free: 30,   trial: null, pro: null },
  analyze: { free: 3,    trial: 10,   pro: null },
  profile: { free: 1,    trial: 3,    pro: null },
} as const

export type Tier      = 'free' | 'trial' | 'pro'
export type UsageType = keyof typeof CALL_LIMITS

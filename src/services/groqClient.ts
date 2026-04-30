import Groq from 'groq-sdk'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const MODEL_SMART = 'llama-3.3-70b-versatile'
const MODEL_FAST  = 'llama-3.1-8b-instant'

// ── Retry logic ───────────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [150, 400]

function isRetryable(err: any): boolean {
  if (!err?.status) return true
  if (err.status === 429) return true
  if (err.status >= 500) return true
  return false
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isRetryable(err)) throw err
      if (attempt === maxAttempts - 1) break
      const delay = RETRY_DELAYS_MS[attempt] ?? 400
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr
}

// ── Parse error ───────────────────────────────────────────────────────────────
export class GroqParseError extends Error {
  cause: unknown
  constructor(cause: unknown) {
    super('Groq returned malformed JSON — model may be overloaded or response was truncated')
    this.name  = 'GroqParseError'
    this.cause = cause
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJSON(raw: string): any {
  const cleaned = raw
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch (cause) {
    throw new GroqParseError(cause)
  }
}

function fmtK(n: number): string {
  if (!n && n !== 0) return '?'
  return n >= 1000 ? `${(n / 1000).toFixed(0)}K` : String(n)
}

function buildProfileSummary(p: any): string {
  if (!p) return 'No profile set'
  return [
    p.currentTitle     ? `Current role: ${p.currentTitle}` : '',
    p.experienceYears  ? `Experience: ${p.experienceYears} years` : '',
    p.targetRoles?.length     ? `Target roles: ${p.targetRoles.join(', ')}` : '',
    p.mustHaveSkills?.length  ? `CRITICAL skills (must appear): ${p.mustHaveSkills.join(', ')}` : '',
    p.primarySkills?.length   ? `Expert skills: ${p.primarySkills.join(', ')}` : '',
    p.secondarySkills?.length ? `Also know: ${p.secondarySkills.join(', ')}` : '',
    p.workTypes?.length  ? `Work preference: ${p.workTypes.join(', ')}` : '',
    p.minSalary > 1000   ? `Min salary: $${fmtK(p.minSalary)}/yr` : '',
    p.dealBreakers?.length    ? `Hard no: ${p.dealBreakers.join(', ')}` : '',
    p.avoidIndustries?.length ? `Avoid industries: ${p.avoidIndustries.join(', ')}` : '',
    p.careerGoal ? `Goal: ${p.careerGoal}` : '',
  ].filter(Boolean).join('\n')
}

// ── batchScoreJobs ────────────────────────────────────────────────────────────

export interface ScoredJob {
  jobId:   string
  score:   number
  label:   'green' | 'amber' | 'red'
  text:    string
  verdict: string
}

export async function batchScoreJobs(
  profile: any,
  jobs:    any[]
): Promise<ScoredJob[]> {
  if (!jobs?.length) return []

  const summary  = buildProfileSummary(profile)
  const jobLines = jobs.map((j: any, i: number) => {
    const salary = j.salary
      ? `$${fmtK(j.salary.low)}–$${fmtK(j.salary.high)}/yr`
      : 'salary not listed'
    const work = j.workType || 'work type unknown'
    return `${i + 1}. [id:${j.jobId || i}] ${j.title || 'Unknown'} at ${j.company || 'Unknown'} · ${work} · ${salary}`
  }).join('\n')

  const response = await withRetry(() =>
    groq.chat.completions.create({
      model:           MODEL_SMART,
      temperature:     0.1,
      max_tokens:      Math.min(200 + jobs.length * 60, 1800),
      response_format: { type: 'json_object' },
      messages: [
        {
          role:    'system',
          content: `You are an expert recruiter scoring job-candidate fit. Be honest and calibrated.

Score guide: 85-100=exceptional, 70-84=strong, 50-69=reasonable, 30-49=weak, 0-29=poor.
Label rules: green≥70, amber 50-69, red <50.
Hard rules:
- If candidate's critical/must-have skills are absent from the job title: cap score at 55
- If job contains any candidate deal-breakers: score must be 0-15
- Generic titles (just "Software Engineer") with no tech stack visible: score 25-40 unless skills strongly align

Return ONLY valid JSON (no markdown):
{
  "results": [
    {"jobId":"<id>","score":<0-100>,"label":"<green|amber|red>","text":"<Exceptional fit|Strong match|Good match|Partial match|Weak fit|Poor fit>","verdict":"<one specific sentence>"},
    ...
  ]
}
Return one entry per job in the same order, no extra fields.`,
        },
        {
          role:    'user',
          content: `CANDIDATE:\n${summary}\n\nJOBS TO SCORE:\n${jobLines}`,
        },
      ],
    })
  )

  const raw    = response.choices[0]?.message?.content ?? '{}'
  const parsed = parseJSON(raw)
  return parsed.results ?? []
}

// ── analyzeJob ────────────────────────────────────────────────────────────────
// Updated to return decision + keyRequirements for the improved panel layout.
// decision:        one direct sentence — apply or skip with a specific reason
// keyRequirements: top 3 things this job actually needs (extracted from JD)
// strengths:       specific matching points for THIS role (not generic)
// gaps:            real gaps with what to do about them
// tips:            role-specific application tips (not "tailor your resume")
// insights:        one non-obvious observation about role/team/company

export interface DeepAnalysis {
  decision:        string
  summary:         string
  keyRequirements: string[]
  strengths:       string[]
  gaps:            string[]
  tips:            string[]
  insights:        string
}

export async function analyzeJob(
  profile:         any,
  jobData:         any,
  fullDescription: string
): Promise<DeepAnalysis> {
  const summary = buildProfileSummary(profile)
  const jobText = [
    `Title: ${jobData.title     || 'Unknown'}`,
    `Company: ${jobData.company || 'Unknown'}`,
    `Location: ${jobData.location  || 'Not specified'}`,
    `Work type: ${jobData.workType || 'Not specified'}`,
    jobData.salary
      ? `Salary: $${fmtK(jobData.salary.low)}–$${fmtK(jobData.salary.high)}/yr`
      : 'Salary: Not listed',
    '',
    'Full job description:',
    (fullDescription || '(not available — scored from card data only)').slice(0, 3800),
  ].join('\n')

  const response = await withRetry(() =>
    groq.chat.completions.create({
      model:           MODEL_SMART,
      temperature:     0.1,
      max_tokens:      1100,
      response_format: { type: 'json_object' },
      messages: [
        {
          role:    'system',
          content: `You are a senior career coach helping a candidate decide whether to apply and how to win this specific role.
Be direct, specific, and tactical. Name actual technologies and requirements. Never give generic advice.
Think like someone who wants this candidate to succeed.

Return ONLY valid JSON:
{
  "decision":        "<one clear verdict — e.g. 'Apply — your Laravel+Vue directly matches their core stack' or 'Stretch — worth applying if you lead with your API work'>",
  "summary":         "<2 sentences: what this role actually involves day-to-day + how well the candidate fits. Be specific about the real tech and team context.>",
  "keyRequirements": ["<top 3 things this job is actually hiring for — pulled verbatim or closely from the description>"],
  "strengths":       ["<2-3 specific reasons this candidate stands out for THIS role — name the matching tech/experience and why it matters to this employer>"],
  "gaps":            ["<gap description — address it by: specific tactic for this application>"],
  "tips":            ["<Cover letter: specific angle to lead with for this role and company>", "<CV: one specific reordering or emphasis change for this application>", "<Interview: one likely question based on the gaps or role complexity>"],
  "insights":        "<one honest, non-obvious coaching observation — could be about role fit, company signal, salary vs market, team dynamics, or a hidden opportunity in the JD>"
}

For gaps: phrase as "No [skill] mentioned — address it by: [specific action]". Use [] if strong match with no real gaps.
For tips: be role-specific. Reference actual requirements from the JD. No phrases like "tailor your resume" or "highlight relevant experience".`,
        },
        {
          role:    'user',
          content: `CANDIDATE:\n${summary}\n\n---\n\n${jobText}`,
        },
      ],
    })
  )

  const raw = response.choices[0]?.message?.content ?? '{}'
  return parseJSON(raw)
}

// ── parseProfile ──────────────────────────────────────────────────────────────

export interface ParsedProfile {
  currentTitle:    string
  experienceYears: number
  targetRoles:     string[]
  workTypes:       string[]
  jobTypes:        string[]
  minSalary:       number
  mustHaveSkills:  string[]
  primarySkills:   string[]
  secondarySkills: string[]
  dealBreakers:    string[]
  avoidIndustries: string[]
  careerGoal:      string
}

export async function parseProfile(text: string): Promise<ParsedProfile> {
  const response = await withRetry(() =>
    groq.chat.completions.create({
      model:           MODEL_FAST,
      temperature:     0.1,
      max_tokens:      500,
      response_format: { type: 'json_object' },
      messages: [
        {
          role:    'system',
          content: `Extract job search preferences from this description.
Return ONLY valid JSON:
{
  "currentTitle":     "<role or ''>",
  "experienceYears":  <0-30>,
  "targetRoles":      ["<2-5 job titles>"],
  "workTypes":        ["<subset of: remote, hybrid, onsite>"],
  "jobTypes":         ["<subset of: full-time, contract, part-time>"],
  "minSalary":        <annual USD or 0>,
  "mustHaveSkills":   ["<2-4 absolutely critical hard skills — dealbreaker if absent>"],
  "primarySkills":    ["<expert-level hard skills>"],
  "secondarySkills":  ["<familiar but not expert>"],
  "dealBreakers":     ["<tech/domains strictly to avoid>"],
  "avoidIndustries":  ["<industries to avoid>"],
  "careerGoal":       "<1 sentence or ''>"
}
Rules: mustHaveSkills = 2-4 skills the person MUST see in the job. No soft skills anywhere. Use [] for anything not mentioned.`,
        },
        { role: 'user', content: text },
      ],
    })
  )

  const raw = response.choices[0]?.message?.content ?? '{}'
  return parseJSON(raw)
}
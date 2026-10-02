/**
 * Who a ChatGPT (Codex) login belongs to, read from the OAuth access token Pi stores.
 * The token is a JWT whose OpenAI claims carry the profile email and the plan; nothing
 * is fetched and nothing is verified here, so the result is display metadata only.
 */
export type CodexIdentity = { email?: string; plan?: string }

const PROFILE_CLAIM = 'https://api.openai.com/profile'
const AUTH_CLAIM = 'https://api.openai.com/auth'

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu'
}

function payload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

export function codexIdentity(accessToken: unknown): CodexIdentity {
  if (typeof accessToken !== 'string') return {}
  const claims = payload(accessToken)
  if (!claims) return {}
  const email = record(claims[PROFILE_CLAIM])?.email ?? claims.email
  const plan = record(claims[AUTH_CLAIM])?.chatgpt_plan_type
  return {
    ...(typeof email === 'string' && email.includes('@') ? { email: email.slice(0, 254) } : {}),
    ...(typeof plan === 'string' && plan
      ? { plan: PLAN_LABEL[plan.toLowerCase()] ?? plan.slice(0, 24) }
      : {})
  }
}

/** The raw ChatGPT account id and plan another engine needs alongside the access token. */
export function codexAccount(accessToken: string): { accountId?: string; planType?: string } {
  const auth = record(payload(accessToken)?.[AUTH_CLAIM])
  const accountId = auth?.chatgpt_account_id
  const plan = auth?.chatgpt_plan_type
  return {
    ...(typeof accountId === 'string' && accountId ? { accountId } : {}),
    ...(typeof plan === 'string' && plan ? { planType: plan } : {})
  }
}

import crypto from 'node:crypto'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

const COOKIE_NAME = 'dashboard_auth'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7 // 7 days

/**
 * Very small auth layer: a shared password, stored in an HTTP-only
 * signed cookie after login. No user accounts, no session store — this is
 * exactly the pattern in the ss-dashboard reference app, adapted for
 * Next.js server components.
 *
 * If DASHBOARD_PASSWORD is unset, auth is disabled (open access). Useful
 * for local development.
 */

function getSecret(): string {
  const secret = process.env.DASHBOARD_AUTH_SECRET || process.env.DASHBOARD_PASSWORD
  if (!secret) throw new Error('DASHBOARD_AUTH_SECRET or DASHBOARD_PASSWORD must be set')
  return secret
}

function sign(value: string): string {
  return crypto.createHmac('sha256', getSecret()).update(value).digest('hex')
}

export function issueCookieValue(): string {
  // Cookie value is just a random nonce + signature. Rotating DASHBOARD_AUTH_SECRET
  // (or DASHBOARD_PASSWORD) invalidates all existing cookies, which is the
  // panic button if you need to kick everyone out.
  const nonce = crypto.randomBytes(16).toString('hex')
  const sig = sign(nonce)
  return `${nonce}.${sig}`
}

export function verifyCookieValue(value: string | undefined): boolean {
  if (!value) return false
  const [nonce, sig] = value.split('.')
  if (!nonce || !sig) return false
  try {
    const expected = sign(nonce)
    const a = Buffer.from(expected)
    const b = Buffer.from(sig)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export const AUTH_COOKIE = {
  name: COOKIE_NAME,
  maxAge: MAX_AGE_SECONDS,
}

/**
 * For server components / pages: redirect to /login if not authenticated.
 * No-op if DASHBOARD_PASSWORD is not set (open access).
 */
export async function requireDashboardAuth(): Promise<void> {
  if (!process.env.DASHBOARD_PASSWORD) return // open access
  const cookieStore = await cookies()
  const value = cookieStore.get(COOKIE_NAME)?.value
  if (!verifyCookieValue(value)) {
    redirect('/login')
  }
}

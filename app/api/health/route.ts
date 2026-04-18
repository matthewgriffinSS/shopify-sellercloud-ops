import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { shopifyRequest } from '@/lib/shopify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type CheckResult = {
  name: string
  ok: boolean
  latencyMs: number | null
  detail: string
}

/**
 * GET /api/health — pings DB, Shopify, Sellercloud in parallel.
 * Returns 200 if all pass, 503 if any fail. Safe to hit frequently.
 *
 * Protected by CRON_SECRET when called programmatically. When called from
 * the /health page in a browser, the page forwards the user's auth cookie
 * instead — the route accepts either.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  const isCron = auth === `Bearer ${process.env.CRON_SECRET}`

  // If not cron, we still want to gate this behind dashboard auth so random
  // internet traffic doesn't probe our service list. The /health page forwards
  // the user's dashboard_auth cookie, which is checked here.
  if (!isCron) {
    const { verifyCookieValue } = await import('@/lib/auth')
    const cookieValue = req.cookies.get('dashboard_auth')?.value
    if (process.env.DASHBOARD_PASSWORD && !verifyCookieValue(cookieValue)) {
      return new Response('Unauthorized', { status: 401 })
    }
  }

  const [db, shopify, sellercloud] = await Promise.all([
    checkDb(),
    checkShopify(),
    checkSellercloud(),
  ])

  const all = [db, shopify, sellercloud]
  const allOk = all.every((c) => c.ok)

  return Response.json(
    {
      ok: allOk,
      checkedAt: new Date().toISOString(),
      checks: all,
    },
    { status: allOk ? 200 : 503 },
  )
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
  const start = Date.now()
  const result = await fn()
  return { result, latencyMs: Date.now() - start }
}

async function checkDb(): Promise<CheckResult> {
  try {
    const { latencyMs } = await timed(async () => {
      const rows = await sql<{ now: Date }[]>`SELECT NOW() as now`
      return rows[0].now
    })
    // Also sanity-check our tables exist.
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'shopify_orders', 'shopify_draft_orders', 'abandoned_checkouts',
          'processing_actions', 'webhook_log'
        )
    `
    const tableCount = parseInt(count)
    if (tableCount < 5) {
      return {
        name: 'database',
        ok: false,
        latencyMs,
        detail: `Expected 5 tables, found ${tableCount}. Did you run db/schema.sql?`,
      }
    }
    return { name: 'database', ok: true, latencyMs, detail: `All 5 tables present` }
  } catch (err) {
    return {
      name: 'database',
      ok: false,
      latencyMs: null,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

async function checkShopify(): Promise<CheckResult> {
  try {
    const { result, latencyMs } = await timed(async () => {
      // shop.json is the cheapest possible authenticated Shopify call.
      // If this works, client_credentials auth + scopes are wired correctly.
      return shopifyRequest<{ shop: { name: string; domain: string } }>('/shop.json')
    })
    return {
      name: 'shopify',
      ok: true,
      latencyMs,
      detail: `Connected to ${result.shop.name} (${result.shop.domain})`,
    }
  } catch (err) {
    return {
      name: 'shopify',
      ok: false,
      latencyMs: null,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

async function checkSellercloud(): Promise<CheckResult> {
  try {
    const baseUrl = process.env.SELLERCLOUD_API_URL
    const username = process.env.SELLERCLOUD_USERNAME
    const password = process.env.SELLERCLOUD_PASSWORD
    if (!baseUrl || !username || !password) {
      return {
        name: 'sellercloud',
        ok: false,
        latencyMs: null,
        detail: 'SELLERCLOUD_API_URL / USERNAME / PASSWORD env vars are not all set',
      }
    }

    const { latencyMs } = await timed(async () => {
      const res = await fetch(`${baseUrl}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Username: username, Password: password }),
      })
      if (!res.ok) {
        throw new Error(`Auth failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
      }
      const data = (await res.json()) as { access_token?: string }
      if (!data.access_token) throw new Error('No access_token in response')
      return data
    })
    return {
      name: 'sellercloud',
      ok: true,
      latencyMs,
      detail: 'Auth succeeded, token received',
    }
  } catch (err) {
    return {
      name: 'sellercloud',
      ok: false,
      latencyMs: null,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

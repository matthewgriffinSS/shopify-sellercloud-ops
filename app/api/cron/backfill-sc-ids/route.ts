import { NextRequest } from 'next/server'
import { backfillScOrderIds } from '@/lib/sellercloud'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Scheduled SC ID backfill.
 *
 * On Autososs, SC's /api/Orders filter params are ignored — it returns newest
 * N regardless. The "targeted" per-order lookup therefore burns ~40s of SC
 * latency to find nothing per order. It's now removed from this cron.
 *
 * Pagination walk is the only effective strategy: fetch N pages of SC orders
 * newest-first, verify each item against our pending candidates using
 * scItemMatches (checks all plausible Shopify-identifier fields).
 *
 * With SC at ~4-8s per page on good days, 18s on bad days, we budget 5 pages.
 * That's 1,250 SC orders scanned per run × 12 runs/day = 15k orders/day
 * covered, which is well above Autososs's order volume.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  const isCron = auth === `Bearer ${process.env.CRON_SECRET}`

  if (!isCron) {
    const cookieValue = req.cookies.get('dashboard_auth')?.value
    const isUser = process.env.DASHBOARD_PASSWORD && verifyCookieValue(cookieValue)
    if (!isUser) {
      return new Response('Unauthorized', { status: 401 })
    }
  }

  const started = Date.now()

  // Wrap in try/catch so a partial timeout still returns useful info if we
  // get that far. maxPages = 5 gives us ~40s of SC work in the worst case
  // (18s × 5 = 90s would be too long, but realistically 2-3 pages finish).
  let result: Awaited<ReturnType<typeof backfillScOrderIds>> | null = null
  let error: string | null = null

  try {
    result = await backfillScOrderIds({
      scope: 'dashboard',
      maxPages: 20,
    })
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  const elapsedMs = Date.now() - started

  return Response.json({
    ok: error === null,
    triggeredBy: isCron ? 'cron' : 'user',
    elapsedMs,
    result,
    error,
  })
}

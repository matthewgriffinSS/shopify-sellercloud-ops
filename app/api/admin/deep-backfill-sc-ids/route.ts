import { NextRequest } from 'next/server'
import { backfillScOrderIds } from '@/lib/sellercloud'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * One-time deep SC ID backfill.
 *
 * Differs from /api/cron/backfill-sc-ids in two ways:
 *  1. maxPages defaults to 30 (instead of 5) — walks much further back in SC
 *     history to catch old late-fulfillment candidates that the regular cron
 *     can never reach.
 *  2. Accepts ?scope=all_recent to widen candidates beyond dashboard-visible.
 *
 * Designed to be hit manually (or a few times in sequence) after a deploy or
 * when the candidatesRemaining count is high. The regular 2-hour cron keeps
 * things current; this endpoint is the batch catch-up.
 *
 * Call from a browser while logged in, or curl it with the CRON_SECRET bearer.
 * Authed via dashboard cookie OR Authorization: Bearer $CRON_SECRET.
 *
 * Example:
 *   curl -sSL --max-time 120 \
 *     -H "Authorization: Bearer $CRON_SECRET" \
 *     "$APP_URL/api/admin/deep-backfill-sc-ids?scope=all_recent&maxPages=30"
 *
 * Re-run until candidatesRemaining stops decreasing or hits zero.
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

  const url = new URL(req.url)
  const scope = url.searchParams.get('scope') === 'all_recent' ? 'all_recent' : 'dashboard'
  const maxPages = Math.min(
    parseInt(url.searchParams.get('maxPages') ?? '30', 10) || 30,
    40, // Cap at 40 regardless of what's passed — protects against accidental /1000 requests.
  )

  const started = Date.now()
  let result: Awaited<ReturnType<typeof backfillScOrderIds>> | null = null
  let error: string | null = null

  try {
    result = await backfillScOrderIds({ scope, maxPages })
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  const elapsedMs = Date.now() - started

  return Response.json({
    ok: error === null,
    scope,
    maxPages,
    elapsedMs,
    result,
    error,
    hint:
      result?.stoppedReason === 'page_cap' && result.candidatesRemaining > 0
        ? 'Hit the page cap with candidates still remaining. Re-run the endpoint — the next pass will pick up where SC new arrivals overlap with the still-pending candidates. If this plateaus, the unmatched candidates likely never reached SC.'
        : result?.stoppedReason === 'walked_past_oldest' && result.candidatesRemaining > 0
          ? 'Walk reached past the oldest candidate date. The remaining candidates almost certainly do not exist in SC — they may be Shopify test orders or orders that never synced.'
          : null,
  })
}

export async function POST(req: NextRequest) {
  return GET(req)
}

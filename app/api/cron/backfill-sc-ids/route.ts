import { NextRequest } from 'next/server'
import { backfillScOrderIdsTargeted, backfillScOrderIds } from '@/lib/sellercloud'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Scheduled SC ID backfill.
 *
 * Called by GitHub Actions (.github/workflows/backfill-sc-ids.yml) every
 * 2 hours. Separated from the late-fulfillment cron because Autososs's
 * /api/Orders endpoint is unpredictably slow (18s per page observed) and
 * was taking down the combined job.
 *
 * Strategy:
 *   1. Try targeted lookup first — per-order filtered list calls. Fast
 *      IF your SC instance respects filters. Autososs doesn't, so step 1
 *      returns matched=0 and we fall through to step 2.
 *   2. Pagination walk with a small maxPages cap. At ~18s per page worst
 *      case, 3 pages = 54s which fits in the 60s function cap with some
 *      headroom for auth + response serialization.
 *
 * At 3 pages × 250 orders × 12 runs/day = 9,000 SC orders scanned daily.
 * That's usually enough to catch a day's new orders. If it's not, the
 * manual /health button is the escape hatch.
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

  // Step 1: targeted. Fast when it works, harmless when it doesn't.
  // Small limit so if SC IS slow even on targeted lookups we don't eat the budget.
  const targeted = await backfillScOrderIdsTargeted({
    scope: 'dashboard',
    limit: 10,
  })

  const targetedElapsed = Date.now() - started

  // Step 2: pagination walk with remaining budget. Only run if we still have
  // meaningful time left AND step 1 didn't already clear the candidate list.
  const remainingBudget = 55_000 - targetedElapsed
  let pagination: Awaited<ReturnType<typeof backfillScOrderIds>> | null = null

  if (targeted.candidatesRemaining > 0 && remainingBudget > 10_000) {
    // At ~18s/page worst case, allow 3 pages if we have 55s left, scale down
    // from there. Minimum 1 page so at least something happens.
    const pagesAfforded = Math.max(1, Math.floor(remainingBudget / 18_000))
    pagination = await backfillScOrderIds({
      scope: 'dashboard',
      maxPages: pagesAfforded,
    }).catch((err) => {
      // Swallow — targeted result is still useful even if pagination blew up.
      return {
        candidatesBefore: 0,
        pagesScanned: 0,
        matched: 0,
        candidatesRemaining: targeted.candidatesRemaining,
        stoppedReason: 'empty_page' as const,
        error: err instanceof Error ? err.message : String(err),
      } as any
    })
  }

  const totalElapsed = Date.now() - started
  const totalMatched = targeted.matched + (pagination?.matched ?? 0)

  return Response.json({
    ok: true,
    triggeredBy: isCron ? 'cron' : 'user',
    totalElapsedMs: totalElapsed,
    targeted: {
      checked: targeted.checked,
      matched: targeted.matched,
      matchedByField: targeted.matchedByField,
      elapsedMs: targetedElapsed,
    },
    pagination: pagination
      ? {
          pagesScanned: pagination.pagesScanned,
          matched: pagination.matched,
          stoppedReason: pagination.stoppedReason,
        }
      : { skipped: true },
    totalMatched,
    candidatesRemaining: pagination?.candidatesRemaining ?? targeted.candidatesRemaining,
  })
}

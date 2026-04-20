import { NextRequest } from 'next/server'
import { backfillScOrderIds } from '@/lib/sellercloud'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Manual Sellercloud ID backfill.
 *
 * This is a thin wrapper around lib/sellercloud.ts::backfillScOrderIds,
 * which is also invoked by the daily cron. Use this endpoint from the
 * /health "Backfill Sellercloud IDs" button when you want an immediate
 * refresh instead of waiting for the next cron run.
 *
 * Paginates SC orders newest-first and matches each against Shopify orders
 * in our DB by EBaySellingManagerSalesRecordNumber. Stops automatically
 * once all candidates are matched or we've walked past the oldest
 * candidate's creation date.
 *
 * Default scope covers orders currently visible on the support dashboard
 * (late fulfillments in last 90 days + VIP in last 7 days). Pass
 * ?scope=all_recent to widen to everything in the last 60 days.
 */
function isAuthed(req: NextRequest): boolean {
  const cookieValue = req.cookies.get('dashboard_auth')?.value
  return !process.env.DASHBOARD_PASSWORD || verifyCookieValue(cookieValue)
}

async function run(req: NextRequest) {
  const url = new URL(req.url)
  const scope = url.searchParams.get('scope') === 'all_recent' ? 'all_recent' : 'dashboard'

  const started = Date.now()
  const result = await backfillScOrderIds({ scope, maxPages: 15 })
  const elapsedMs = Date.now() - started

  return Response.json({
    ok: true,
    scope,
    elapsedMs,
    ...result,
    // Preserved aliases so the existing /health UI (which expects
    // `checked`, `found`, `notFound`, `errors`, `remaining`) keeps working
    // without needing to be redeployed in lockstep.
    checked: result.candidatesBefore,
    found: result.matched,
    notFound: result.candidatesRemaining,
    errors: 0,
    remaining: result.candidatesRemaining,
    note:
      result.stoppedReason === 'all_found'
        ? 'All candidates matched. No remaining lookups needed.'
        : result.stoppedReason === 'walked_past_oldest'
          ? `Walked past oldest candidate's date. ${result.candidatesRemaining} remain — those orders likely don't exist in SC yet.`
          : result.stoppedReason === 'page_cap'
            ? `Hit page cap (${result.pagesScanned} pages). ${result.candidatesRemaining} remain. Re-run to continue, or bump maxPages.`
            : `SC returned an empty page after ${result.pagesScanned} pages. ${result.candidatesRemaining} remain.`,
  })
}

export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return new Response('Unauthorized', { status: 401 })
  try {
    return await run(req)
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  return GET(req)
}

import { NextRequest } from 'next/server'
import { backfillScOrderIdsTargeted } from '@/lib/sellercloud'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Manual Sellercloud ID backfill — targeted per-order version.
 *
 * For each Shopify order that needs a SC ID, we call SC's filtered list
 * endpoint once per candidate identifier field:
 *
 *   - EBaySellingManagerSalesRecordNumber (Shopify numeric ID)
 *   - OrderSourceOrderID                  (Shopify order_number)
 *   - CompletedOrderID                    (Shopify name like "SS311729")
 *
 * First hit wins. Matched-on-field counts come back in the response so we
 * can see which field SC is actually populating on your instance.
 *
 * Default caps at 60 orders per run. Re-run until `remaining` is 0.
 * Pass ?limit=<n> to adjust (watch out for the 60s function timeout).
 * Pass ?scope=all_recent to widen beyond late+VIP.
 */
function isAuthed(req: NextRequest): boolean {
  const cookieValue = req.cookies.get('dashboard_auth')?.value
  return !process.env.DASHBOARD_PASSWORD || verifyCookieValue(cookieValue)
}

async function run(req: NextRequest) {
  const url = new URL(req.url)
  const scope = url.searchParams.get('scope') === 'all_recent' ? 'all_recent' : 'dashboard'
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam ? Math.max(1, Math.min(200, parseInt(limitParam, 10))) : 60

  const started = Date.now()
  const result = await backfillScOrderIdsTargeted({ scope, limit })
  const elapsedMs = Date.now() - started

  return Response.json({
    ok: true,
    scope,
    limit,
    elapsedMs,
    ...result,
    // Preserved aliases so the existing /health UI keeps rendering.
    checked: result.checked,
    found: result.matched,
    notFound: result.notFound,
    errors: result.errors.length,
    remaining: result.candidatesRemaining,
    errorDetails: result.errors,
    note:
      result.candidatesRemaining === 0
        ? `All candidates matched. Matched by field: ${formatMatchedBy(result.matchedByField)}.`
        : result.matched > 0
          ? `Matched ${result.matched} via ${formatMatchedBy(result.matchedByField)}. ${result.candidatesRemaining} remain — re-run the button to continue.`
          : `No matches from this batch of ${result.checked}. ${result.candidatesRemaining} remain — either the orders aren't in SC yet, or none of the three identifier fields are populated on your SC instance.`,
  })
}

function formatMatchedBy(m: Record<string, number>): string {
  const entries = Object.entries(m)
  if (entries.length === 0) return '(none)'
  return entries.map(([k, v]) => `${k}=${v}`).join(', ')
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

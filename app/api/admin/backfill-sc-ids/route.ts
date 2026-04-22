import { NextRequest } from 'next/server'
import { findScOrderByAnyShopifyId } from '@/lib/sellercloud'
import { sql } from '@/lib/db'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Manual Sellercloud ID backfill — targeted per-order version with a
 * hard wall-clock budget.
 *
 * Why the budget: SC list calls can take 400–1500ms each, and each candidate
 * may cost up to 3 calls (one per identifier field). Without a budget we hit
 * Vercel's 60s timeout and the whole run comes back as a 504 with no data
 * written. The wall-clock check stops cleanly at ~50s and returns partial
 * results so the user sees progress and can click again.
 *
 * Default limit is intentionally low (25). Re-run the button until
 * `remaining` is 0. Override via ?limit=<n> once you know your throughput.
 */
function isAuthed(req: NextRequest): boolean {
  const cookieValue = req.cookies.get('dashboard_auth')?.value
  return !process.env.DASHBOARD_PASSWORD || verifyCookieValue(cookieValue)
}

const DEFAULT_LIMIT = 25
const TIME_BUDGET_MS = 50_000 // leave 10s headroom under Vercel's 60s cap

type CandidateRow = {
  id: string
  order_number: string
  raw_payload: any
}

async function run(req: NextRequest) {
  const url = new URL(req.url)
  const scope = url.searchParams.get('scope') === 'all_recent' ? 'all_recent' : 'dashboard'
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam
    ? Math.max(1, Math.min(200, parseInt(limitParam, 10)))
    : DEFAULT_LIMIT

  const started = Date.now()

  const candidates =
    scope === 'dashboard'
      ? await sql<CandidateRow[]>`
          SELECT id::text, order_number, raw_payload
          FROM shopify_orders
          WHERE sellercloud_order_id IS NULL
            AND (
              ((fulfillment_status IS NULL OR fulfillment_status != 'fulfilled')
               AND shopify_created_at < NOW() - INTERVAL '3 days'
               AND shopify_created_at > NOW() - INTERVAL '14 days')
              OR
              (is_vip = TRUE AND shopify_created_at > NOW() - INTERVAL '7 days')
            )
          ORDER BY shopify_created_at DESC
          LIMIT ${limit}
        `
      : await sql<CandidateRow[]>`
          SELECT id::text, order_number, raw_payload
          FROM shopify_orders
          WHERE sellercloud_order_id IS NULL
            AND shopify_created_at > NOW() - INTERVAL '60 days'
          ORDER BY shopify_created_at DESC
          LIMIT ${limit}
        `

  const candidatesBefore = candidates.length
  const matchedByField: Record<string, number> = {}
  const errors: Array<{ orderNumber: string; error: string }> = []
  let matched = 0
  let notFound = 0
  let checked = 0
  let stoppedEarly = false

  for (const row of candidates) {
    // Budget check before each order — a single SC call could exceed the
    // remaining budget, so bail before starting it rather than after.
    if (Date.now() - started > TIME_BUDGET_MS) {
      stoppedEarly = true
      break
    }

    try {
      const shopifyName =
        typeof row.raw_payload?.name === 'string' ? row.raw_payload.name : null

      const hit = await findScOrderByAnyShopifyId({
        shopifyNumericId: row.id,
        shopifyOrderNumber: row.order_number,
        shopifyName,
      })

      checked += 1

      if (hit) {
        await sql`
          UPDATE shopify_orders
          SET sellercloud_order_id = ${hit.ID}, updated_at = NOW()
          WHERE id = ${row.id}::bigint
        `
        matched += 1
        matchedByField[hit.matchedOn] = (matchedByField[hit.matchedOn] ?? 0) + 1
      } else {
        notFound += 1
      }
    } catch (err) {
      errors.push({
        orderNumber: row.order_number,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Recount what's still outstanding.
  const [{ remaining }] =
    scope === 'dashboard'
      ? await sql<{ remaining: string }[]>`
          SELECT COUNT(*)::text AS remaining
          FROM shopify_orders
          WHERE sellercloud_order_id IS NULL
            AND (
              ((fulfillment_status IS NULL OR fulfillment_status != 'fulfilled')
               AND shopify_created_at < NOW() - INTERVAL '3 days'
               AND shopify_created_at > NOW() - INTERVAL '14 days')
              OR
              (is_vip = TRUE AND shopify_created_at > NOW() - INTERVAL '7 days')
            )
        `
      : await sql<{ remaining: string }[]>`
          SELECT COUNT(*)::text AS remaining
          FROM shopify_orders
          WHERE sellercloud_order_id IS NULL
            AND shopify_created_at > NOW() - INTERVAL '60 days'
        `

  const elapsedMs = Date.now() - started
  const candidatesRemaining = parseInt(remaining)

  return Response.json({
    ok: true,
    scope,
    limit,
    elapsedMs,
    candidatesBefore,
    checked,
    matched,
    matchedByField,
    notFound,
    errors: errors.length,
    errorDetails: errors,
    remaining: candidatesRemaining,
    stoppedEarly,
    // Preserved alias for the existing /health UI.
    found: matched,
    note:
      candidatesRemaining === 0
        ? `All candidates matched. Matched by field: ${formatMatchedBy(matchedByField)}.`
        : stoppedEarly
          ? `Stopped at ${elapsedMs}ms to avoid timeout after checking ${checked} of ${candidatesBefore}. Matched ${matched} via ${formatMatchedBy(matchedByField)}. ${candidatesRemaining} remain — click again to continue.`
          : matched > 0
            ? `Matched ${matched} via ${formatMatchedBy(matchedByField)}. ${candidatesRemaining} remain — click again.`
            : `No matches from this batch of ${checked}. ${candidatesRemaining} remain. If this persists, your SC instance is likely ignoring the filter params (Autososs does this) — the daily cron's pagination walk is the fallback.`,
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

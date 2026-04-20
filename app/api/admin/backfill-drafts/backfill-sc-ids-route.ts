import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { findScOrderByShopifyId } from '@/lib/sellercloud'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Backfills sellercloud_order_id for orders currently visible on the
 * support dashboard that don't yet have one.
 *
 * Scope is intentionally narrow — only orders that are either:
 *   - late (unfulfilled and > 3 days old), or
 *   - VIP within the last 7 days
 *
 * Everything else stays NULL until it shows up on the dashboard. That
 * keeps SC API usage proportional to what reps actually see.
 *
 * Cap of 100 orders per run keeps us safely under Vercel's 60s timeout
 * even on slow SC responses. Re-run the endpoint until `remaining` is 0.
 *
 * Accepts both GET (so you can trigger it by visiting the URL while logged
 * into the dashboard) and POST (for automation / curl).
 */
async function runBackfill() {
  // Orders that need a SC ID AND are currently visible on the dashboard.
  const rows = await sql<{ id: string; order_number: string }[]>`
    SELECT id::text, order_number
    FROM shopify_orders
    WHERE sellercloud_order_id IS NULL
      AND (
        -- late fulfillments
        ((fulfillment_status IS NULL OR fulfillment_status != 'fulfilled')
         AND shopify_created_at < NOW() - INTERVAL '3 days')
        OR
        -- VIP this week
        (is_vip = TRUE AND shopify_created_at > NOW() - INTERVAL '7 days')
      )
    ORDER BY shopify_created_at DESC
    LIMIT 100
  `

  let found = 0
  let notFound = 0
  let errors = 0
  const errorDetails: Array<{ orderNumber: string; error: string }> = []

  for (const row of rows) {
    try {
      const scOrder = await findScOrderByShopifyId(row.id)
      if (scOrder) {
        await sql`
          UPDATE shopify_orders
          SET sellercloud_order_id = ${scOrder.ID}, updated_at = NOW()
          WHERE id = ${row.id}::bigint
        `
        found += 1
      } else {
        notFound += 1
      }
    } catch (err) {
      errors += 1
      errorDetails.push({
        orderNumber: row.order_number,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // How many still need a SC ID after this run? If > 0, run the endpoint again.
  const [{ remaining }] = await sql<{ remaining: string }[]>`
    SELECT COUNT(*)::text AS remaining
    FROM shopify_orders
    WHERE sellercloud_order_id IS NULL
      AND (
        ((fulfillment_status IS NULL OR fulfillment_status != 'fulfilled')
         AND shopify_created_at < NOW() - INTERVAL '3 days')
        OR
        (is_vip = TRUE AND shopify_created_at > NOW() - INTERVAL '7 days')
      )
  `

  return Response.json({
    ok: true,
    checked: rows.length,
    found,
    notFound,
    errors,
    remaining: parseInt(remaining),
    errorDetails: errorDetails.slice(0, 10),
    note:
      parseInt(remaining) > 0
        ? `${remaining} orders still need SC IDs. Re-run this endpoint to pick them up.`
        : notFound > 0
          ? `All reachable orders checked. ${notFound} orders weren't found in Sellercloud (may not have synced yet or have a different ChannelOrderID).`
          : 'All late and VIP orders now have Sellercloud IDs.',
  })
}

function isAuthed(req: NextRequest): boolean {
  const cookieValue = req.cookies.get('dashboard_auth')?.value
  return !process.env.DASHBOARD_PASSWORD || verifyCookieValue(cookieValue)
}

export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return new Response('Unauthorized', { status: 401 })
  try {
    return await runBackfill()
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

import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { fetchStaleUnfulfilledOrders } from '@/lib/shopify'
import { parseTags, isVipOrder } from '@/lib/tags'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Late-fulfillment scan.
 *
 * Called two ways:
 *   1. Automatically by Vercel Cron once a day at 07:00 UTC (vercel.json)
 *      — Vercel sends Authorization: Bearer $CRON_SECRET
 *   2. Manually by a logged-in user via the "Run now" button on /health
 *      — forwards the user's dashboard auth cookie
 *
 * Finds Shopify orders unfulfilled >= 3 days and upserts them into the
 * local mirror so they appear on the dashboard's Late Fulfillments section.
 *
 * Replaces: the "Late fulfillment" Shopify Flow's 3-day wait + condition + tag steps.
 *
 * Note: Hobby plan limits crons to once per day. If you need faster refresh,
 * upgrade to Pro (unlimited) or trigger manually from /health.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  const isCron = auth === `Bearer ${process.env.CRON_SECRET}`

  if (!isCron) {
    // Allow logged-in dashboard users to trigger manually.
    const cookieValue = req.cookies.get('dashboard_auth')?.value
    const isUser = process.env.DASHBOARD_PASSWORD && verifyCookieValue(cookieValue)
    if (!isUser) {
      return new Response('Unauthorized', { status: 401 })
    }
  }

  const { orders } = await fetchStaleUnfulfilledOrders(3)
  let upserted = 0

  for (const order of orders) {
    const tags = parseTags(order.tags)
    const totalPrice = parseFloat(order.total_price)
    const customerName =
      [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || null

    await sql`
      INSERT INTO shopify_orders (
        id, order_number, customer_name, customer_email, total_price, currency,
        financial_status, fulfillment_status, source_name, tags, is_vip,
        assigned_rep, service_type, raw_payload, shopify_created_at
      ) VALUES (
        ${order.id}, ${String(order.order_number)}, ${customerName}, ${order.email},
        ${totalPrice}, ${order.currency}, ${order.financial_status}, ${order.fulfillment_status},
        ${order.source_name}, ${tags.raw}, ${isVipOrder(totalPrice)},
        ${tags.rep}, ${tags.service}, ${sql.json(order)}, ${order.created_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        tags = EXCLUDED.tags,
        fulfillment_status = EXCLUDED.fulfillment_status,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
    `
    upserted += 1
  }

  return Response.json({ ok: true, checked: orders.length, upserted, triggeredBy: isCron ? 'cron' : 'user' })
}

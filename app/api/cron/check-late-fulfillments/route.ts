import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { fetchStaleUnfulfilledOrders } from '@/lib/shopify'
import { parseTags, isVipOrder } from '@/lib/tags'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Daily / frequent Shopify reconciliation.
 *
 * Scans Shopify for orders unfulfilled ≥ 3 days and upserts them into our
 * mirror. Catches anything the orders/updated webhook might have dropped.
 * Replaces the old "Late fulfillment" Shopify Flow.
 *
 * Called two ways:
 *   1. Vercel Cron (once daily at 07:00 UTC per vercel.json — Hobby-plan backup)
 *   2. GitHub Actions (.github/workflows/check-late-fulfillments.yml) every 6h
 *   3. Manual "Run now" button on /health (uses dashboard auth)
 *
 * Note: SC ID backfill USED to run here too, but Autososs's /api/Orders
 * endpoint is unpredictably slow (seen 18s per page). It kept timing out
 * the combined job. SC backfill now runs as its own cron hitting
 * /api/admin/backfill-sc-ids, which has its own wall-clock budget and
 * can't take down the late-fulfillment job when SC is having a bad day.
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
        customer_name = COALESCE(EXCLUDED.customer_name, shopify_orders.customer_name),
        customer_email = COALESCE(EXCLUDED.customer_email, shopify_orders.customer_email),
        tags = EXCLUDED.tags,
        fulfillment_status = EXCLUDED.fulfillment_status,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
    `
    upserted += 1
  }

  return Response.json({
    ok: true,
    triggeredBy: isCron ? 'cron' : 'user',
    checked: orders.length,
    upserted,
  })
}

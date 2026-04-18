import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { fetchStaleUnfulfilledOrders } from '@/lib/shopify'
import { parseTags, isVipOrder } from '@/lib/tags'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Runs every 6 hours via vercel.json cron.
 * Finds Shopify orders that have been unfulfilled for >= 3 days
 * and upserts them into our local mirror so they appear on the dashboard.
 *
 * Replaces: the "Late fulfillment" Shopify Flow's 3-day wait + condition + tag steps.
 */
export async function GET(req: NextRequest) {
  // Verify it's actually Vercel cron calling us (Vercel sends this header).
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
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

  return Response.json({ ok: true, checked: orders.length, upserted })
}

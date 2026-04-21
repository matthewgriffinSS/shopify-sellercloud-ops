import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { verifyShopifyWebhook, type ShopifyOrder } from '@/lib/shopify'
import { parseTags, isVipOrder } from '@/lib/tags'
import { logWebhook } from '@/lib/webhook-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Handles: orders/updated webhook.
 * Keeps our local mirror fresh when fulfillment status / tags change in Shopify.
 *
 * Must include customer_name in the INSERT: Shopify occasionally fires
 * orders/updated BEFORE orders/create (or orders/create webhook fails and
 * the subsequent update is our only signal). When that happens the row
 * gets created here, and without customer_name in the INSERT it lands as
 * NULL and never fills itself in. The ON CONFLICT uses COALESCE so we
 * don't stomp on a name that's already set.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text()
  const sig = req.headers.get('x-shopify-hmac-sha256')
  const ok = verifyShopifyWebhook(raw, sig, process.env.SHOPIFY_WEBHOOK_SECRET ?? '')

  if (!ok) {
    await logWebhook({ topic: 'orders/updated', signatureOk: false, error: 'invalid signature' })
    return new Response('Invalid signature', { status: 401 })
  }

  const order = JSON.parse(raw) as ShopifyOrder
  const tags = parseTags(order.tags)
  const totalPrice = parseFloat(order.total_price)
  const customerName =
    [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || null

  try {
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
        assigned_rep = EXCLUDED.assigned_rep,
        service_type = EXCLUDED.service_type,
        is_vip = EXCLUDED.is_vip,
        financial_status = EXCLUDED.financial_status,
        fulfillment_status = EXCLUDED.fulfillment_status,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
    `
    await logWebhook({
      topic: 'orders/updated',
      shopifyId: order.id,
      signatureOk: true,
      processed: true,
    })
    return Response.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logWebhook({
      topic: 'orders/updated',
      shopifyId: order.id,
      signatureOk: true,
      error: message,
    })
    return new Response(`Error: ${message}`, { status: 500 })
  }
}

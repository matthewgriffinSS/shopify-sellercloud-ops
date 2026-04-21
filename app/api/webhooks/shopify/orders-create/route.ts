import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { verifyShopifyWebhook, type ShopifyOrder } from '@/lib/shopify'
import { parseTags, isVipOrder } from '@/lib/tags'
import { logWebhook } from '@/lib/webhook-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Handles: orders/create webhook.
 * Replaces: "Order reference" flow + "VIP order over $2000" flow.
 *
 * Also marks the matching abandoned cart as recovered if there is one.
 * Shopify puts `checkout_token` on the created order; we store `token`
 * on abandoned_checkouts, so the match is exact — no false positives.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text()
  const sig = req.headers.get('x-shopify-hmac-sha256')
  const ok = verifyShopifyWebhook(raw, sig, process.env.SHOPIFY_WEBHOOK_SECRET ?? '')

  if (!ok) {
    await logWebhook({ topic: 'orders/create', signatureOk: false, error: 'invalid signature' })
    return new Response('Invalid signature', { status: 401 })
  }

  // The order payload has more fields than our ShopifyOrder type exposes —
  // notably checkout_token. Pull it off the parsed JSON before casting.
  const orderRaw = JSON.parse(raw) as ShopifyOrder & { checkout_token?: string | null }
  const order = orderRaw as ShopifyOrder
  const checkoutToken = orderRaw.checkout_token ?? null

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
        tags = EXCLUDED.tags,
        assigned_rep = EXCLUDED.assigned_rep,
        service_type = EXCLUDED.service_type,
        is_vip = EXCLUDED.is_vip,
        financial_status = EXCLUDED.financial_status,
        fulfillment_status = EXCLUDED.fulfillment_status,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
    `

    // Token-based abandoned cart recovery. Exact match, no false positives.
    // If there's no matching cart, this is a no-op — we don't log anything,
    // because most orders won't have been preceded by a $2k+ abandoned cart.
    if (checkoutToken) {
      await sql`
        UPDATE abandoned_checkouts
        SET recovered_at = NOW()
        WHERE token = ${checkoutToken}
          AND recovered_at IS NULL
      `
    }

    await logWebhook({
      topic: 'orders/create',
      shopifyId: order.id,
      signatureOk: true,
      processed: true,
    })
    return Response.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logWebhook({
      topic: 'orders/create',
      shopifyId: order.id,
      signatureOk: true,
      error: message,
    })
    return new Response(`Error: ${message}`, { status: 500 })
  }
}

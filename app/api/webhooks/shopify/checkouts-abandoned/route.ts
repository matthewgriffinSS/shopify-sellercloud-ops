import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { verifyShopifyWebhook } from '@/lib/shopify'
import { isVipOrder } from '@/lib/tags'
import { logWebhook } from '@/lib/webhook-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Checkout = {
  id: number
  token: string
  email: string | null
  total_price: string
  line_items: Array<{ id: number }>
  abandoned_checkout_url?: string
  created_at: string
  updated_at: string
  customer: { first_name: string | null; last_name: string | null } | null
}

/**
 * Handles: checkouts/create + checkouts/update webhooks.
 * Replaces: the "Abandoned Cart $2000+" flow.
 *
 * We only persist carts >=$2000 to keep the table focused.
 * Shopify fires checkouts/update when a checkout is abandoned
 * (and also on every step of the checkout flow — we dedupe via ON CONFLICT).
 */
export async function POST(req: NextRequest) {
  const raw = await req.text()
  const sig = req.headers.get('x-shopify-hmac-sha256')
  const topic = req.headers.get('x-shopify-topic') ?? 'checkouts/update'
  const ok = verifyShopifyWebhook(raw, sig, process.env.SHOPIFY_WEBHOOK_SECRET ?? '')

  if (!ok) {
    await logWebhook({ topic, signatureOk: false, error: 'invalid signature' })
    return new Response('Invalid signature', { status: 401 })
  }

  const checkout = JSON.parse(raw) as Checkout
  const total = parseFloat(checkout.total_price)

  // Only track high-value abandoned carts — same threshold as the old flow.
  if (!isVipOrder(total)) {
    await logWebhook({
      topic,
      shopifyId: checkout.id,
      signatureOk: true,
      processed: true,
      error: 'skipped: below $2000 threshold',
    })
    return Response.json({ ok: true, skipped: true })
  }

  const customerName =
    [checkout.customer?.first_name, checkout.customer?.last_name].filter(Boolean).join(' ') || null

  try {
    await sql`
      INSERT INTO abandoned_checkouts (
        id, token, customer_email, customer_name, total_price,
        line_item_count, abandoned_at, raw_payload
      ) VALUES (
        ${checkout.id}, ${checkout.token}, ${checkout.email}, ${customerName},
        ${total}, ${checkout.line_items?.length ?? 0}, ${checkout.updated_at},
        ${sql.json(checkout)}
      )
      ON CONFLICT (id) DO UPDATE SET
        total_price = EXCLUDED.total_price,
        line_item_count = EXCLUDED.line_item_count,
        abandoned_at = EXCLUDED.abandoned_at,
        raw_payload = EXCLUDED.raw_payload
    `
    await logWebhook({ topic, shopifyId: checkout.id, signatureOk: true, processed: true })
    return Response.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logWebhook({ topic, shopifyId: checkout.id, signatureOk: true, error: message })
    return new Response(`Error: ${message}`, { status: 500 })
  }
}

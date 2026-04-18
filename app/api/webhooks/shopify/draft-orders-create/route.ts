import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { verifyShopifyWebhook } from '@/lib/shopify'
import { parseTags } from '@/lib/tags'
import { logWebhook } from '@/lib/webhook-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type DraftOrder = {
  id: number
  name: string
  email: string | null
  total_price: string
  status: string
  tags: string
  created_at: string
  customer: { first_name: string | null; last_name: string | null } | null
  order_id: number | null // populated once the draft is converted
}

/**
 * Handles: draft_orders/create and draft_orders/update webhooks.
 * Replaces: the "Draft order follow up" flow with 7 rep conditions.
 * One insert, rep parsed from tags — no per-rep branching needed.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text()
  const sig = req.headers.get('x-shopify-hmac-sha256')
  const topic = req.headers.get('x-shopify-topic') ?? 'draft_orders/create'
  const ok = verifyShopifyWebhook(raw, sig, process.env.SHOPIFY_WEBHOOK_SECRET ?? '')

  if (!ok) {
    await logWebhook({ topic, signatureOk: false, error: 'invalid signature' })
    return new Response('Invalid signature', { status: 401 })
  }

  const draft = JSON.parse(raw) as DraftOrder
  const tags = parseTags(draft.tags)
  const customerName =
    [draft.customer?.first_name, draft.customer?.last_name].filter(Boolean).join(' ') || null

  try {
    await sql`
      INSERT INTO shopify_draft_orders (
        id, name, customer_name, customer_email, total_price, status,
        tags, assigned_rep, converted_order_id, raw_payload, shopify_created_at
      ) VALUES (
        ${draft.id}, ${draft.name}, ${customerName}, ${draft.email},
        ${parseFloat(draft.total_price)}, ${draft.status},
        ${tags.raw}, ${tags.rep}, ${draft.order_id},
        ${sql.json(draft)}, ${draft.created_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        tags = EXCLUDED.tags,
        assigned_rep = EXCLUDED.assigned_rep,
        converted_order_id = EXCLUDED.converted_order_id,
        total_price = EXCLUDED.total_price,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
    `
    await logWebhook({ topic, shopifyId: draft.id, signatureOk: true, processed: true })
    return Response.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logWebhook({ topic, shopifyId: draft.id, signatureOk: true, error: message })
    return new Response(`Error: ${message}`, { status: 500 })
  }
}

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
  phone: string | null
  total_price: string
  status: string
  tags: string
  created_at: string
  customer: {
    first_name: string | null
    last_name: string | null
    phone: string | null
  } | null
  order_id: number | null // populated once the draft is converted
}

/**
 * Handles: draft_orders/create and draft_orders/update webhooks.
 * Replaces: the "Draft order follow up" flow with 7 rep conditions.
 * One insert, rep parsed from tags — no per-rep branching needed.
 *
 * IMPORTANT: The follow-up tracking columns (followed_up, email_followup, sms_*,
 * phone_*, richpanel_link, rep_notes, can_delete) are rep-owned state edited
 * through the dashboard. The ON CONFLICT clause deliberately does NOT touch
 * those columns so Shopify updates never stomp on a rep's work.
 *
 * converted_at is stamped the first time we see a converted_order_id appear.
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
  const customerPhone = draft.customer?.phone ?? draft.phone ?? null

  try {
    await sql`
      INSERT INTO shopify_draft_orders (
        id, name, customer_name, customer_email, customer_phone,
        total_price, status, tags, assigned_rep, service_type,
        converted_order_id, raw_payload, shopify_created_at
      ) VALUES (
        ${draft.id}, ${draft.name}, ${customerName}, ${draft.email}, ${customerPhone},
        ${parseFloat(draft.total_price)}, ${draft.status},
        ${tags.raw}, ${tags.rep}, ${tags.service},
        ${draft.order_id}, ${sql.json(draft)}, ${draft.created_at}
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        tags = EXCLUDED.tags,
        assigned_rep = EXCLUDED.assigned_rep,
        service_type = EXCLUDED.service_type,
        customer_name = EXCLUDED.customer_name,
        customer_email = EXCLUDED.customer_email,
        customer_phone = EXCLUDED.customer_phone,
        converted_order_id = EXCLUDED.converted_order_id,
        total_price = EXCLUDED.total_price,
        raw_payload = EXCLUDED.raw_payload,
        converted_at = CASE
          WHEN shopify_draft_orders.converted_at IS NULL
               AND EXCLUDED.converted_order_id IS NOT NULL
          THEN NOW()
          ELSE shopify_draft_orders.converted_at
        END,
        updated_at = NOW()
        -- NOTE: followed_up, email_followup, sms_followup, sms_date,
        -- phone_followup, phone_call_date, richpanel_link, rep_notes,
        -- can_delete are deliberately not updated here. They're owned by
        -- the rep via the dashboard.
    `
    await logWebhook({ topic, shopifyId: draft.id, signatureOk: true, processed: true })
    return Response.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logWebhook({ topic, shopifyId: draft.id, signatureOk: true, error: message })
    return new Response(`Error: ${message}`, { status: 500 })
  }
}

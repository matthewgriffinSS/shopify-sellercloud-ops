import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { shopifyRequest } from '@/lib/shopify'
import { parseTags } from '@/lib/tags'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

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
  order_id: number | null
}

/**
 * POST /api/admin/backfill-drafts
 * Pulls open and invoice_sent draft orders from Shopify and inserts them
 * into our mirror, bypassing webhooks. Run once after setting up to populate
 * existing drafts, or whenever you suspect the webhook dropped events.
 *
 * Same conflict rules as the webhook handler: never overwrite rep-owned
 * follow-up state.
 */
export async function POST(req: NextRequest) {
  const cookieValue = req.cookies.get('dashboard_auth')?.value
  if (process.env.DASHBOARD_PASSWORD && !verifyCookieValue(cookieValue)) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    // Pull only invoice_sent drafts. The dashboard doesn't show "open" drafts
    // (rep built the cart but never sent the invoice), so there's no point
    // backfilling them. Completed drafts are already real orders.
    const { draft_orders } = await shopifyRequest<{ draft_orders: DraftOrder[] }>(
      `/draft_orders.json?status=invoice_sent&limit=250`,
    )

    let upserted = 0
    for (const draft of draft_orders) {
      const tags = parseTags(draft.tags)
      const customerName =
        [draft.customer?.first_name, draft.customer?.last_name].filter(Boolean).join(' ') || null
      const customerPhone = draft.customer?.phone ?? draft.phone ?? null

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
      `
      upserted += 1
    }

    // Count how many invoice_sent drafts within 60 days now lack an assigned_rep.
    // These won't appear in any rep's follow-up view.
    const [{ unassigned }] = await sql<{ unassigned: string }[]>`
      SELECT COUNT(*)::text AS unassigned
      FROM shopify_draft_orders
      WHERE status = 'invoice_sent'
        AND shopify_created_at > NOW() - INTERVAL '60 days'
        AND service_type IS NULL
        AND can_delete = FALSE
        AND assigned_rep IS NULL
    `

    return Response.json({
      ok: true,
      fetched: draft_orders.length,
      upserted,
      unassignedAfterBackfill: parseInt(unassigned),
      note: parseInt(unassigned) > 0
        ? 'Some invoiced drafts have no assigned rep — likely missing rep name in their tags. These will not appear in the rep grid.'
        : 'All invoiced drafts have an assigned rep.',
    })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

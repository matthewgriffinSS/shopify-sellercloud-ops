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
  total_price: string
  status: string
  tags: string
  created_at: string
  customer: { first_name: string | null; last_name: string | null } | null
  order_id: number | null
}

/**
 * POST /api/admin/backfill-drafts
 * Pulls all open draft orders from Shopify and inserts them into our mirror,
 * bypassing webhooks. Run once after setting up to populate existing drafts,
 * or whenever you suspect the webhook dropped events.
 */
export async function POST(req: NextRequest) {
  const cookieValue = req.cookies.get('dashboard_auth')?.value
  if (process.env.DASHBOARD_PASSWORD && !verifyCookieValue(cookieValue)) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    const params = new URLSearchParams({ status: 'open', limit: '250' })
    const { draft_orders } = await shopifyRequest<{ draft_orders: DraftOrder[] }>(
      `/draft_orders.json?${params.toString()}`,
    )

    let upserted = 0
    for (const draft of draft_orders) {
      const tags = parseTags(draft.tags)
      const customerName =
        [draft.customer?.first_name, draft.customer?.last_name].filter(Boolean).join(' ') || null

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
          total_price = EXCLUDED.total_price,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `
      upserted += 1
    }

    // Count how many drafts now lack an assigned_rep — useful diagnostic.
    const [{ unassigned }] = await sql<{ unassigned: string }[]>`
      SELECT COUNT(*)::text AS unassigned
      FROM shopify_draft_orders
      WHERE status = 'open' AND assigned_rep IS NULL
    `

    return Response.json({
      ok: true,
      fetched: draft_orders.length,
      upserted,
      unassignedAfterBackfill: parseInt(unassigned),
      note: parseInt(unassigned) > 0
        ? 'Some drafts have no assigned rep — likely missing rep name in their tags. These will not appear in the rep grid.'
        : 'All open drafts have an assigned rep.',
    })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { shopifyRequestRaw, parseNextPageInfo } from '@/lib/shopify'
import { isVipOrder } from '@/lib/tags'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Checkout = {
  id: number
  token?: string
  email?: string | null
  total_price: string
  line_items?: Array<{ id: number }>
  created_at?: string
  updated_at?: string
  customer?: { first_name: string | null; last_name: string | null } | null
}

/**
 * Polls Shopify every 2h for abandoned checkouts in the last 7 days and
 * upserts every $2000+ one into abandoned_checkouts.
 *
 * Why this exists as a cron in addition to the checkouts/update webhook:
 * the webhook is unreliable. Shopify's checkouts/update event doesn't
 * always fire on cart abandonment — it depends on whether the shopper
 * hit any checkout step, how the storefront session ended, whether they
 * were on a bot-ish user agent, etc. Polling is the safety net.
 *
 * Same filter as the manual backfill button and the webhook handler:
 * total_price >= $2000. Same ON CONFLICT rules so repeated polling just
 * refreshes rows without overwriting recovered_at.
 *
 * Called two ways:
 *   1. Vercel Cron every 2h at :15 past (vercel.json)
 *   2. Manual curl with Authorization: Bearer $CRON_SECRET
 *
 * Also callable by logged-in dashboard users hitting the URL directly.
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

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const initialQuery = new URLSearchParams({
      limit: '250',
      updated_at_min: sevenDaysAgo,
    })

    const checkouts: Checkout[] = []
    let nextPath: string | null = `/checkouts.json?${initialQuery.toString()}`
    let pageCount = 0
    const MAX_PAGES = 10

    while (nextPath && pageCount < MAX_PAGES) {
      const { body, linkHeader } = await shopifyRequestRaw<{ checkouts: Checkout[] }>(nextPath)
      checkouts.push(...body.checkouts)
      pageCount += 1

      const cursor = parseNextPageInfo(linkHeader)
      nextPath = cursor
        ? `/checkouts.json?limit=250&page_info=${encodeURIComponent(cursor)}`
        : null
    }

    let skippedLowValue = 0
    let upserted = 0

    for (const checkout of checkouts) {
      const total = parseFloat(checkout.total_price)
      if (!isVipOrder(total)) {
        skippedLowValue += 1
        continue
      }

      const customerName =
        [checkout.customer?.first_name, checkout.customer?.last_name]
          .filter(Boolean)
          .join(' ') || null
      const customerEmail = checkout.email ?? null
      const token = checkout.token ?? null
      const lineItemCount = checkout.line_items?.length ?? 0
      const abandonedAt =
        checkout.updated_at ?? checkout.created_at ?? new Date().toISOString()

      await sql`
        INSERT INTO abandoned_checkouts (
          id, token, customer_email, customer_name, total_price,
          line_item_count, abandoned_at, raw_payload
        ) VALUES (
          ${checkout.id}, ${token}, ${customerEmail}, ${customerName},
          ${total}, ${lineItemCount}, ${abandonedAt},
          ${sql.json(checkout)}
        )
        ON CONFLICT (id) DO UPDATE SET
          total_price = EXCLUDED.total_price,
          line_item_count = EXCLUDED.line_item_count,
          abandoned_at = EXCLUDED.abandoned_at,
          raw_payload = EXCLUDED.raw_payload
      `
      upserted += 1
    }

    // Auto-recover: any cart whose token now matches an order in
    // shopify_orders is a converted cart. Mark it recovered if we haven't
    // already — handy for carts that were created via polling, whose
    // matching orders/create webhook fired before we had the cart row.
    const recoverResult = await sql<{ id: string }[]>`
      UPDATE abandoned_checkouts ac
      SET recovered_at = NOW()
      WHERE ac.recovered_at IS NULL
        AND ac.token IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM shopify_orders so
          WHERE so.raw_payload->>'checkout_token' = ac.token
        )
      RETURNING id::text
    `

    return Response.json({
      ok: true,
      triggeredBy: isCron ? 'cron' : 'user',
      fetched: checkouts.length,
      upserted,
      skippedLowValue,
      autoRecovered: recoverResult.length,
      pagesFetched: pageCount,
    })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

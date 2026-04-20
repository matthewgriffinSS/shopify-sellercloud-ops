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
 * POST /api/admin/backfill-abandoned-carts
 *
 * Pulls abandoned checkouts from Shopify for the last 7 days (same window
 * the /sales dashboard shows) and upserts every $2000+ one into
 * abandoned_checkouts. Same filter the checkouts-abandoned webhook applies.
 *
 * Use this after webhook outages, on first deploy, or to retroactively
 * populate carts that were dropped before the UNDEFINED_VALUE fix landed.
 * Safe to re-run — ON CONFLICT handles duplicates.
 */
export async function POST(req: NextRequest) {
  const cookieValue = req.cookies.get('dashboard_auth')?.value
  if (process.env.DASHBOARD_PASSWORD && !verifyCookieValue(cookieValue)) {
    return new Response('Unauthorized', { status: 401 })
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
    const MAX_PAGES = 10 // 10 × 250 = 2500 carts per run; plenty for 7 days

    while (nextPath && pageCount < MAX_PAGES) {
      const { body, linkHeader } = await shopifyRequestRaw<{ checkouts: Checkout[] }>(nextPath)
      checkouts.push(...body.checkouts)
      pageCount += 1

      const cursor = parseNextPageInfo(linkHeader)
      nextPath = cursor
        ? `/checkouts.json?limit=250&page_info=${encodeURIComponent(cursor)}`
        : null
    }

    const truncated = pageCount >= MAX_PAGES && nextPath !== null

    let skippedLowValue = 0
    let upserted = 0

    for (const checkout of checkouts) {
      const total = parseFloat(checkout.total_price)
      if (!isVipOrder(total)) {
        skippedLowValue += 1
        continue
      }

      // Mirror the null-coalescing the webhook handler does — Shopify
      // routinely omits these fields on early checkout states.
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

    // What will actually show on /sales after this run?
    const [{ visible }] = await sql<{ visible: string }[]>`
      SELECT COUNT(*)::text AS visible
      FROM abandoned_checkouts
      WHERE abandoned_at > NOW() - INTERVAL '7 days'
        AND recovered_at IS NULL
    `

    return Response.json({
      ok: true,
      fetched: checkouts.length,
      upserted,
      skippedLowValue,
      pagesFetched: pageCount,
      truncated,
      visibleOnDashboard: parseInt(visible),
      note: truncated
        ? `Hit the ${MAX_PAGES}-page safety cap (${MAX_PAGES * 250} carts). Re-run to fetch more.`
        : upserted === 0 && checkouts.length > 0
          ? `Fetched ${checkouts.length} checkouts but none hit the $2000 threshold.`
          : `${visible} high-value carts now visible on /sales.`,
    })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

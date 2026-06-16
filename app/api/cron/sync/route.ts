import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import {
  fetchStaleUnfulfilledOrders,
  fetchRecentOrders,
  shopifyRequestRaw,
  parseNextPageInfo,
  type ShopifyOrder,
} from '@/lib/shopify'
import { parseTags, isVipOrder } from '@/lib/tags'
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
 * Consolidated Shopify → Postgres sync.
 *
 * Replaces the separate check-late-fulfillments and poll-abandoned-carts crons,
 * AND replaces the real-time orders/create, orders/updated, and checkouts/update
 * webhooks. Doing all of it in one scheduled run means a single Neon compute
 * wake per run instead of one wake per webhook event — which is what keeps
 * scale-to-zero compute usage low.
 *
 * Each run, inside one compute wake:
 *   1. Mirrors orders created in the last 7 days (status=any) — covers new
 *      orders and VIP orders for the dashboard's 7-day VIP window.
 *   2. Mirrors all open, unfulfilled orders older than 3 days (any age) —
 *      covers the long tail of late fulfillments.
 *   3. Polls abandoned checkouts from the last 7 days, upserts every $2000+
 *      one, then marks any cart recovered whose token now matches a mirrored
 *      order (the recovery the orders/create webhook used to do).
 *   4. Housekeeping, free because we're already awake: trims webhook_log and
 *      sync_runs to 30 days, and nulls raw_payload on rows older than 60 days
 *      that nothing reads anymore — this is what keeps the Neon free-tier
 *      0.5 GB storage limit comfortable.
 *   5. Logs the run to sync_runs (success or failure), which powers the
 *      "Synced 23m ago" indicator in the dashboard header.
 *
 * Draft orders are intentionally NOT handled here — they stay on their
 * draft_orders/create + draft_orders/update webhooks, which are low-volume
 * (reps create drafts by hand) and only fire while someone is already using
 * the dashboard, so they don't add idle compute wakes.
 *
 * Auth: Authorization: Bearer $CRON_SECRET (GitHub Actions) OR a logged-in
 * dashboard cookie. Because it's a GET, you can also trigger it manually just
 * by visiting /api/cron/sync in the browser while signed in — or with the
 * "Sync now" button in the dashboard header.
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

  const started = Date.now()
  const triggeredBy = isCron ? 'cron' : 'user'

  try {
    // ---- 1 + 2: Orders ----
    const recent = await fetchRecentOrders(7)
    const { orders: stale } = await fetchStaleUnfulfilledOrders(3)

    // Dedupe by id — a 3–7 day old unfulfilled order shows up in both fetches.
    const ordersById = new Map<number, ShopifyOrder>()
    for (const o of [...recent, ...stale]) ordersById.set(o.id, o)
    const orders = [...ordersById.values()]

    let ordersUpserted = 0
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
      ordersUpserted += 1
    }

    // ---- 3: Abandoned checkouts ----
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

    let cartsUpserted = 0
    let skippedLowValue = 0
    for (const checkout of checkouts) {
      const total = parseFloat(checkout.total_price)
      if (!isVipOrder(total)) {
        skippedLowValue += 1
        continue
      }
      const customerName =
        [checkout.customer?.first_name, checkout.customer?.last_name].filter(Boolean).join(' ') ||
        null
      const customerEmail = checkout.email ?? null
      const token = checkout.token ?? null
      const lineItemCount = checkout.line_items?.length ?? 0
      const abandonedAt = checkout.updated_at ?? checkout.created_at ?? new Date().toISOString()

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
      cartsUpserted += 1
    }

    // Cart recovery: any cart whose token matches a mirrored order is recovered.
    // Works because step 1 mirrors the converting order into shopify_orders.
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

    // ---- 4: Housekeeping (same compute wake, effectively free) ----

    // Webhook audit rows older than 30 days. Only the draft webhooks write
    // here now, but the table never stops growing without this.
    const [weblogPurge] = await sql<{ count: string }[]>`
      WITH purged AS (
        DELETE FROM webhook_log
        WHERE received_at < NOW() - INTERVAL '30 days'
        RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM purged
    `

    // Our own run log gets the same 30-day retention.
    await sql`
      DELETE FROM sync_runs
      WHERE ran_at < NOW() - INTERVAL '30 days'
    `

    // Null out full Shopify JSON payloads nothing reads anymore. After the
    // one-time backfill in migration 003, each run only touches the handful
    // of rows that crossed the 60-day line since the last run. (Old stale
    // unfulfilled orders keep theirs — the order upsert above re-fills them
    // each run anyway, and they're the late-fulfillment working set.)
    const [payloadsNulled] = await sql<{ count: string }[]>`
      WITH nulled AS (
        UPDATE shopify_orders
        SET raw_payload = NULL
        WHERE raw_payload IS NOT NULL
          AND fulfillment_status = 'fulfilled'
          AND shopify_created_at < NOW() - INTERVAL '60 days'
        RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM nulled
    `
    await sql`
      UPDATE abandoned_checkouts
      SET raw_payload = NULL
      WHERE raw_payload IS NOT NULL
        AND abandoned_at < NOW() - INTERVAL '60 days'
    `
    await sql`
      UPDATE shopify_draft_orders
      SET raw_payload = NULL
      WHERE raw_payload IS NOT NULL
        AND shopify_created_at < NOW() - INTERVAL '60 days'
    `

    // ---- 5: Log the run ----
    const elapsedMs = Date.now() - started
    await sql`
      INSERT INTO sync_runs (
        ok, triggered_by, elapsed_ms, orders_upserted, carts_upserted, auto_recovered
      ) VALUES (
        TRUE, ${triggeredBy}, ${elapsedMs}, ${ordersUpserted}, ${cartsUpserted},
        ${recoverResult.length}
      )
    `

    return Response.json({
      ok: true,
      triggeredBy,
      elapsedMs,
      ordersFetched: orders.length,
      ordersUpserted,
      cartsFetched: checkouts.length,
      cartsUpserted,
      skippedLowValue,
      autoRecovered: recoverResult.length,
      weblogRowsPurged: parseInt(weblogPurge.count),
      payloadsNulled: parseInt(payloadsNulled.count),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // Best-effort failure logging so the header indicator can say
    // "Sync failed 2h ago" instead of silently going stale. Wrapped in its
    // own try so a database outage doesn't mask the original error.
    try {
      await sql`
        INSERT INTO sync_runs (ok, triggered_by, elapsed_ms, error)
        VALUES (FALSE, ${triggeredBy}, ${Date.now() - started}, ${message})
      `
    } catch {
      // Nothing else to do — the GitHub Actions job will still fail and email.
    }

    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

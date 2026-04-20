import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { fetchStaleUnfulfilledOrders } from '@/lib/shopify'
import { parseTags, isVipOrder } from '@/lib/tags'
import { verifyCookieValue } from '@/lib/auth'
import { backfillScOrderIds, type BackfillResult } from '@/lib/sellercloud'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Daily sync job. Called two ways:
 *
 *   1. Automatically by Vercel Cron once a day at 07:00 UTC (vercel.json).
 *      Vercel sends Authorization: Bearer $CRON_SECRET.
 *   2. Manually by a logged-in user via the "Run now" button on /health.
 *      Uses the user's dashboard auth cookie.
 *
 * Does two things in sequence:
 *
 *   (a) Late-fulfillment scan: pull Shopify orders unfulfilled ≥ 3 days and
 *       upsert into our mirror. Catches anything the orders/updated webhook
 *       might have dropped. Replaces the old "Late fulfillment" Shopify Flow.
 *
 *   (b) SC ID backfill: for any orders visible on the support dashboard
 *       that still lack a sellercloud_order_id, paginate SC orders and
 *       match by EBaySellingManagerSalesRecordNumber. See
 *       lib/sellercloud.ts::backfillScOrderIds for the matching logic.
 *
 * Hobby plan allows one cron per day. If you need faster SC link freshness,
 * either click the /health button on demand or move to Pro for unlimited
 * crons (then consider every 4–6 hours).
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

  // -------- (a) Late-fulfillment reconciliation --------
  const { orders } = await fetchStaleUnfulfilledOrders(3)
  let upserted = 0

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
        fulfillment_status = EXCLUDED.fulfillment_status,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
    `
    upserted += 1
  }

  // -------- (b) SC ID backfill --------
  // Wrapped in try/catch so a SC outage never fails the whole cron — the
  // Shopify reconciliation above is the more important half.
  let scResult: BackfillResult | null = null
  let scError: string | null = null
  try {
    scResult = await backfillScOrderIds({ scope: 'dashboard' })
  } catch (err) {
    scError = err instanceof Error ? err.message : String(err)
  }

  return Response.json({
    ok: true,
    triggeredBy: isCron ? 'cron' : 'user',
    shopifyScan: {
      checked: orders.length,
      upserted,
    },
    sellercloudBackfill: scResult
      ? {
          candidatesBefore: scResult.candidatesBefore,
          matched: scResult.matched,
          remaining: scResult.candidatesRemaining,
          pagesScanned: scResult.pagesScanned,
          stoppedReason: scResult.stoppedReason,
        }
      : { error: scError },
    // Backward-compat: the /health UI reads `checked` and `upserted` at the
    // top level. Preserve that so the existing button keeps showing sensible
    // results without a UI redeploy.
    checked: orders.length,
    upserted,
  })
}

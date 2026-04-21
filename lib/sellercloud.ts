// ============================================================================
// PATCH: add these two functions to lib/sellercloud.ts
//
// Place them after backfillScOrderIds() and before the "-- Order notes --" section.
// They don't touch anything else — old code keeps working.
// ============================================================================

// -------------- Targeted SC lookup (per-order filter) --------------

/**
 * SC supports filtering its order list by several Shopify-identifier fields.
 * We don't know which one is populated on a given instance, so we try them in
 * a deliberate order per order:
 *
 *   1. EBaySellingManagerSalesRecordNumber  — Shopify numeric ID (documented)
 *   2. OrderSourceOrderID                   — Shopify order number
 *   3. CompletedOrderID                     — Shopify name ("SS311729")
 *
 * The tryName is exactly what SC expects as the query-param key. These are
 * the names SC's REST docs use for filtering on /api/Orders.
 */
const SC_LOOKUP_FIELDS = [
  'EBaySellingManagerSalesRecordNumber',
  'OrderSourceOrderID',
  'CompletedOrderID',
] as const

/**
 * Find one SC order by any of its plausible Shopify-identifier fields.
 *
 * `shopifyNumericId` is the Shopify numeric order ID (e.g. "5123456789").
 * `shopifyOrderNumber` is the Shopify order_number (e.g. "311729") — optional.
 * `shopifyName` is the Shopify name with prefix (e.g. "SS311729") — optional.
 *
 * Each attempt is a single filtered list call, so even if SC has 500k orders
 * we only pull back 0–1 matching records per attempt. Returns the first hit.
 *
 * Why not just try all three as OR in one query? SC's REST doesn't support OR
 * across different fields in the list filter, so three calls it is. In practice
 * the first one hits for most orders and the extras only fire on misses.
 */
export async function findScOrderByAnyShopifyId(identifiers: {
  shopifyNumericId: string | number
  shopifyOrderNumber?: string | number | null
  shopifyName?: string | null
}): Promise<{ ID: number; matchedOn: string } | null> {
  const byField: Record<string, string | null> = {
    EBaySellingManagerSalesRecordNumber: String(identifiers.shopifyNumericId),
    OrderSourceOrderID: identifiers.shopifyOrderNumber
      ? String(identifiers.shopifyOrderNumber)
      : null,
    CompletedOrderID: identifiers.shopifyName ?? null,
  }

  for (const field of SC_LOOKUP_FIELDS) {
    const value = byField[field]
    if (!value) continue

    try {
      const params = new URLSearchParams({
        [`model.${field}`]: value,
        'model.pageNumber': '1',
        'model.pageSize': '5',
      })
      const data = await scRequest<{ Items?: ScListOrder[] }>(
        `/api/Orders?${params.toString()}`,
      )
      const items = data.Items ?? []
      if (items.length > 0) {
        return { ID: items[0].ID, matchedOn: field }
      }
    } catch {
      // Swallow per-field errors — move on to the next field.
    }
  }

  return null
}

// -------------- Targeted bulk backfill --------------

export type TargetedBackfillResult = {
  candidatesBefore: number
  checked: number
  matched: number
  matchedByField: Record<string, number>
  notFound: number
  candidatesRemaining: number
  errors: Array<{ orderNumber: string; error: string }>
}

/**
 * Per-order targeted backfill. Instead of walking all SC orders and checking
 * each one against our candidate set (O(N_sc_orders)), we go candidate-by-
 * candidate and ask SC directly "do you have this order, by any of three
 * identifier fields?" (O(N_candidates)).
 *
 * Much better when most candidates aren't in SC yet (3 SC requests per miss
 * is still cheaper than paging through 10k SC orders to find 1 match).
 *
 * Takes about 0.3–1.0s per order depending on SC latency. Default limit of
 * 60 keeps us comfortably under Vercel's 60s function timeout.
 */
export async function backfillScOrderIdsTargeted(options: {
  limit?: number
  scope?: 'dashboard' | 'all_recent'
} = {}): Promise<TargetedBackfillResult> {
  const limit = options.limit ?? 60
  const scope = options.scope ?? 'dashboard'

  const candidates =
    scope === 'dashboard'
      ? await sql<
          { id: string; order_number: string; raw_payload: any }[]
        >`
          SELECT id::text, order_number, raw_payload
          FROM shopify_orders
          WHERE sellercloud_order_id IS NULL
            AND (
              ((fulfillment_status IS NULL OR fulfillment_status != 'fulfilled')
               AND shopify_created_at < NOW() - INTERVAL '3 days'
               AND shopify_created_at > NOW() - INTERVAL '90 days')
              OR
              (is_vip = TRUE AND shopify_created_at > NOW() - INTERVAL '7 days')
            )
          ORDER BY shopify_created_at DESC
          LIMIT ${limit}
        `
      : await sql<
          { id: string; order_number: string; raw_payload: any }[]
        >`
          SELECT id::text, order_number, raw_payload
          FROM shopify_orders
          WHERE sellercloud_order_id IS NULL
            AND shopify_created_at > NOW() - INTERVAL '60 days'
          ORDER BY shopify_created_at DESC
          LIMIT ${limit}
        `

  const candidatesBefore = candidates.length
  const matchedByField: Record<string, number> = {}
  const errors: Array<{ orderNumber: string; error: string }> = []
  let matched = 0
  let notFound = 0

  for (const row of candidates) {
    try {
      // Shopify "name" (e.g. "SS311729") lives in raw_payload.name.
      const shopifyName =
        typeof row.raw_payload?.name === 'string' ? row.raw_payload.name : null

      const hit = await findScOrderByAnyShopifyId({
        shopifyNumericId: row.id,
        shopifyOrderNumber: row.order_number,
        shopifyName,
      })

      if (hit) {
        await sql`
          UPDATE shopify_orders
          SET sellercloud_order_id = ${hit.ID}, updated_at = NOW()
          WHERE id = ${row.id}::bigint
        `
        matched += 1
        matchedByField[hit.matchedOn] = (matchedByField[hit.matchedOn] ?? 0) + 1
      } else {
        notFound += 1
      }
    } catch (err) {
      errors.push({
        orderNumber: row.order_number,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Recount what's left.
  const [{ remaining }] =
    scope === 'dashboard'
      ? await sql<{ remaining: string }[]>`
          SELECT COUNT(*)::text AS remaining
          FROM shopify_orders
          WHERE sellercloud_order_id IS NULL
            AND (
              ((fulfillment_status IS NULL OR fulfillment_status != 'fulfilled')
               AND shopify_created_at < NOW() - INTERVAL '3 days'
               AND shopify_created_at > NOW() - INTERVAL '90 days')
              OR
              (is_vip = TRUE AND shopify_created_at > NOW() - INTERVAL '7 days')
            )
        `
      : await sql<{ remaining: string }[]>`
          SELECT COUNT(*)::text AS remaining
          FROM shopify_orders
          WHERE sellercloud_order_id IS NULL
            AND shopify_created_at > NOW() - INTERVAL '60 days'
        `

  return {
    candidatesBefore,
    checked: candidates.length,
    matched,
    matchedByField,
    notFound,
    candidatesRemaining: parseInt(remaining),
    errors: errors.slice(0, 10),
  }
}

// Sellercloud REST API client — configured for Autososs (autososs.api.sellercloud.us)
//
// Auth: JWT via POST /rest/api/token with { Username, Password } body.
// Token is valid for 60 minutes per Sellercloud docs. We cache for 50 minutes
// with a safety margin and use inflight deduplication for cold-start races.
//
// All request paths below use the /rest/api/... prefix documented in Sellercloud's
// Swagger. Visit https://autososs.api.sellercloud.us/rest/swagger/ui/ to browse them.
//
// Design note re: Shopify order ID → SC order ID lookup:
//
// We confirmed experimentally that SC's GET /api/Orders list endpoint IGNORES
// every documented filter parameter (model.channelOrderID / customerOrderID /
// orderSourceOrderID, any casing). It just returns the newest N orders
// regardless. So we can't filter server-side for the bulk backfill.
//
// Instead, we paginate the unfiltered list (which does include the Shopify
// identifier inline per item under `EBaySellingManagerSalesRecordNumber`)
// and match client-side against our shopify_orders table. Results are
// cached in shopify_orders.sellercloud_order_id so subsequent lookups for
// the same order are a single DB read.
//
// There's ALSO a targeted path (findScOrderByAnyShopifyId / backfillScOrderIdsTargeted)
// that calls SC per-order with filter params. It tries three field names per
// candidate. If your SC instance silently ignores the filters like Autososs
// does, you'll get 0 matches and can fall back to the pagination path.

import { sql } from './db'

type TokenResponse = {
  access_token: string
  token_type: string
  username: string
  expires_in: number
}

let cachedToken: string | null = null
let cachedAt = 0
let inflight: Promise<string> | null = null
const TOKEN_TTL_MS = 50 * 60 * 1000

async function getToken(): Promise<string> {
  const baseUrl = process.env.SELLERCLOUD_API_URL
  const username = process.env.SELLERCLOUD_USERNAME
  const password = process.env.SELLERCLOUD_PASSWORD
  if (!baseUrl || !username || !password) {
    throw new Error('SELLERCLOUD_API_URL / USERNAME / PASSWORD must be set')
  }

  const now = Date.now()
  if (cachedToken && now - cachedAt < TOKEN_TTL_MS) return cachedToken
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const res = await fetch(`${baseUrl}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Username: username, Password: password }),
      })
      if (!res.ok) {
        throw new Error(`Sellercloud auth failed: ${res.status} ${await res.text()}`)
      }
      const data = (await res.json()) as TokenResponse
      if (!data.access_token) {
        throw new Error('Sellercloud did not return access_token')
      }
      cachedToken = data.access_token
      cachedAt = Date.now()
      return cachedToken
    } finally {
      inflight = null
    }
  })()

  return inflight
}

async function scRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getToken()
  const res = await fetch(`${process.env.SELLERCLOUD_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  if (!res.ok) {
    throw new Error(`Sellercloud ${path}: ${res.status} ${await res.text()}`)
  }
  // Some Sellercloud endpoints return 200 with empty body on success.
  const text = await res.text()
  if (!text) return undefined as unknown as T
  return JSON.parse(text) as T
}

// -------------- Order list pagination --------------

/**
 * One page of SC orders. We only pull fields we actually use — SC returns
 * ~71 fields per item by default and we don't care about most of them, but
 * there's no server-side projection so we just drop them on the ground here.
 */
export type ScListOrder = {
  ID: number
  EBaySellingManagerSalesRecordNumber: string | null // Shopify numeric order ID as string
  OrderSourceOrderID: string | null // Shopify order number ("311729")
  CompletedOrderID?: string | null // Shopify name ("SS311729")
  TimeOfOrder: string // ISO date, when Shopify placed the order
  CreatedOn: string // ISO date, when SC received it
}

type ScListResponse = {
  Items?: ScListOrder[]
}

/**
 * Fetch one page of SC orders, newest first (SC default sort).
 * pageSize capped at 250 per SC's documented limit.
 */
export async function listScOrders(page: number, pageSize = 250): Promise<ScListOrder[]> {
  const params = new URLSearchParams({
    'model.pageNumber': String(page),
    'model.pageSize': String(Math.min(pageSize, 250)),
  })
  const data = await scRequest<ScListResponse>(`/api/Orders?${params.toString()}`)
  return data.Items ?? []
}

// -------------- Order lookup (cached) --------------

/**
 * Resolve a Shopify order ID to its SC counterpart.
 *
 * Fast path: read the cached mapping from shopify_orders.sellercloud_order_id.
 *
 * Slow path: paginate up to MAX_LIVE_PAGES (= a few thousand orders, enough
 * to cover the last several days of SC activity) looking for an order whose
 * EBaySellingManagerSalesRecordNumber matches the Shopify numeric ID.
 * Caches the result on the shopify_orders row so subsequent calls are fast.
 *
 * Returns { ID } so existing callers that use `scOrder.ID` keep working.
 */
const MAX_LIVE_PAGES = 10 // ~2500 recent SC orders; covers days to weeks

export async function findScOrderByShopifyId(
  shopifyIdentifier: string | number,
): Promise<{ ID: number } | null> {
  const shopifyId = String(shopifyIdentifier)

  // Fast path: DB cache.
  const cached = await sql<{ sellercloud_order_id: string | null }[]>`
    SELECT sellercloud_order_id::text FROM shopify_orders
    WHERE id = ${shopifyId}::bigint
    LIMIT 1
  `
  if (cached[0]?.sellercloud_order_id) {
    return { ID: parseInt(cached[0].sellercloud_order_id) }
  }

  // Slow path: paginate, match, cache.
  for (let page = 1; page <= MAX_LIVE_PAGES; page++) {
    const items = await listScOrders(page, 250)
    if (items.length === 0) break

    const match = items.find((i) => i.EBaySellingManagerSalesRecordNumber === shopifyId)
    if (match) {
      await sql`
        UPDATE shopify_orders
        SET sellercloud_order_id = ${match.ID}, updated_at = NOW()
        WHERE id = ${shopifyId}::bigint
      `
      return { ID: match.ID }
    }
  }

  return null
}

// -------------- Bulk SC ID backfill (pagination walk) --------------

export type BackfillResult = {
  candidatesBefore: number
  pagesScanned: number
  matched: number
  candidatesRemaining: number
  stoppedReason: 'all_found' | 'page_cap' | 'walked_past_oldest' | 'empty_page'
}

/**
 * Walk SC orders newest-first, matching each against our shopify_orders
 * candidates and populating sellercloud_order_id. Runs safely to completion
 * or until we've walked past our oldest candidate's date.
 *
 * Used from:
 *   - /api/cron/check-late-fulfillments (daily, after the stale scan)
 *
 * `scope` defaults to dashboard-visible orders only (late + VIP).
 */
export async function backfillScOrderIds(options: {
  scope?: 'dashboard' | 'all_recent'
  maxPages?: number
} = {}): Promise<BackfillResult> {
  const scope = options.scope ?? 'dashboard'
  const maxPages = options.maxPages ?? 40 // 40 × 250 = 10,000 SC orders, several weeks worth

  // Candidates: orders missing a SC ID that we actually care about.
  const candidates =
    scope === 'dashboard'
      ? await sql<{ id: string; shopify_created_at: Date }[]>`
          SELECT id::text, shopify_created_at
          FROM shopify_orders
          WHERE sellercloud_order_id IS NULL
            AND (
              -- late fulfillments
              ((fulfillment_status IS NULL OR fulfillment_status != 'fulfilled')
               AND shopify_created_at < NOW() - INTERVAL '3 days'
               AND shopify_created_at > NOW() - INTERVAL '90 days')
              OR
              -- VIP this week
              (is_vip = TRUE AND shopify_created_at > NOW() - INTERVAL '7 days')
            )
        `
      : await sql<{ id: string; shopify_created_at: Date }[]>`
          SELECT id::text, shopify_created_at
          FROM shopify_orders
          WHERE sellercloud_order_id IS NULL
            AND shopify_created_at > NOW() - INTERVAL '60 days'
        `

  const candidatesBefore = candidates.length
  if (candidatesBefore === 0) {
    return {
      candidatesBefore: 0,
      pagesScanned: 0,
      matched: 0,
      candidatesRemaining: 0,
      stoppedReason: 'all_found',
    }
  }

  // Map by Shopify numeric ID for O(1) lookup during the walk.
  const pending = new Map<string, { createdAt: Date }>()
  let oldest = new Date()
  for (const c of candidates) {
    pending.set(c.id, { createdAt: new Date(c.shopify_created_at) })
    if (c.shopify_created_at < oldest) oldest = new Date(c.shopify_created_at)
  }

  // Buffer: SC orders may be created slightly before/after the Shopify order,
  // so we walk back a bit further than strict equality would demand.
  const stopBefore = new Date(oldest.getTime() - 2 * 24 * 60 * 60 * 1000)

  let matched = 0
  let pagesScanned = 0
  let stoppedReason: BackfillResult['stoppedReason'] = 'page_cap'

  for (let page = 1; page <= maxPages; page++) {
    const items = await listScOrders(page, 250)
    pagesScanned = page

    if (items.length === 0) {
      stoppedReason = 'empty_page'
      break
    }

    for (const item of items) {
      const shopifyId = item.EBaySellingManagerSalesRecordNumber
      if (!shopifyId) continue
      if (!pending.has(shopifyId)) continue

      try {
        await sql`
          UPDATE shopify_orders
          SET sellercloud_order_id = ${item.ID}, updated_at = NOW()
          WHERE id = ${shopifyId}::bigint
            AND sellercloud_order_id IS NULL
        `
        matched += 1
        pending.delete(shopifyId)
      } catch {
        // Swallow individual row failures so one bad row doesn't abort the walk.
      }
    }

    if (pending.size === 0) {
      stoppedReason = 'all_found'
      break
    }

    // Check if this page's oldest order is already past all candidates.
    // If so, further pagination won't help — no older candidate could match
    // older SC orders that don't exist yet in Shopify.
    const pageOldest = new Date(items[items.length - 1].TimeOfOrder)
    if (pageOldest < stopBefore) {
      stoppedReason = 'walked_past_oldest'
      break
    }
  }

  return {
    candidatesBefore,
    pagesScanned,
    matched,
    candidatesRemaining: pending.size,
    stoppedReason,
  }
}

// -------------- Targeted SC lookup (per-order filter) --------------

/**
 * SC supports filtering its order list by several Shopify-identifier fields
 * (on instances where the filter params are actually respected — Autososs
 * notably ignores them, so this may return 0 results per call there).
 *
 * We don't know which field SC's importer is populating on a given instance,
 * so we try them in a deliberate order per order:
 *
 *   1. EBaySellingManagerSalesRecordNumber  — Shopify numeric ID (documented)
 *   2. OrderSourceOrderID                   — Shopify order number
 *   3. CompletedOrderID                     — Shopify name ("SS311729")
 */
const SC_LOOKUP_FIELDS = [
  'EBaySellingManagerSalesRecordNumber',
  'OrderSourceOrderID',
  'CompletedOrderID',
] as const

/**
 * Find one SC order by any of its plausible Shopify-identifier fields.
 *
 * Each attempt is a single filtered list call, so even if SC has 500k orders
 * we only pull back 0–1 matching records per attempt. Returns the first hit.
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

// -------------- Order notes --------------

/**
 * Add a note to a Sellercloud order.
 * Endpoint: POST /rest/api/Orders/{id}/Notes
 */
export async function addOrderNote(scOrderId: number | string, note: string) {
  await scRequest(`/api/Orders/${scOrderId}/Notes`, {
    method: 'POST',
    body: JSON.stringify({ Note: note }),
  })
  return { ok: true as const }
}

// -------------- Shipments --------------

/**
 * Mark an order as shipped with tracking info.
 * Endpoint: POST /rest/api/Orders/{id}/Shipment (singular) per Sellercloud docs.
 *
 * Shape per the "Mark Order as Shipped" endpoint. Adjust `ShippingCarrier` /
 * `ShippingService` to match valid keys on your SC instance — get the full list
 * from GET /api/Inventory/ShippingCarriers.
 */
export async function createShipment(
  scOrderId: number | string,
  input: { carrier: string; tracking: string; note?: string },
) {
  await scRequest(`/api/Orders/${scOrderId}/Shipment`, {
    method: 'POST',
    body: JSON.stringify({
      TrackingNumber: input.tracking,
      ShippingCarrier: input.carrier,
      Note: input.note ?? '',
    }),
  })
  return { ok: true as const }
}

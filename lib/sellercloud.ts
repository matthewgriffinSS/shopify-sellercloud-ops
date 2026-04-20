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
// regardless. So we can't filter server-side.
//
// Instead, we paginate the unfiltered list (which does include the Shopify
// identifier inline per item under `EBaySellingManagerSalesRecordNumber`)
// and match client-side against our shopify_orders table. Results are
// cached in shopify_orders.sellercloud_order_id so subsequent lookups for
// the same order are a single DB read.

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

// -------------- Bulk SC ID backfill --------------

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
 * Used from two places:
 *   - /api/admin/backfill-sc-ids (manual trigger)
 *   - /api/cron/check-late-fulfillments (daily, after the stale scan)
 *
 * `scope` defaults to dashboard-visible orders only (late + VIP). The cron
 * uses this. The admin endpoint can pass 'all_recent' to widen the net.
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

// Sellercloud REST API client — configured for Autososs (autososs.api.sellercloud.us)
//
// Auth: JWT via POST /rest/api/token with { Username, Password } body.
// Token is valid for 60 minutes per Sellercloud docs. We cache for 50 minutes
// with a safety margin and use inflight deduplication for cold-start races.
//
// IMPORTANT DESIGN NOTE re: Shopify → SC order matching.
//
// We confirmed experimentally (by inspecting a wrongly-matched order) that
// Autososs's /api/Orders endpoint IGNORES filter parameters — passing
// `model.OrderSourceOrderID=311870` returns the newest 5 orders regardless,
// the same way no filter would. If we trust SC's response and take items[0]
// as "the match," we'll silently link every Shopify order to whatever the
// newest SC order happens to be at lookup time. That's exactly the bug we
// saw: Shopify #311870 linked to SC-5057725, which was actually for order
// #311567 belonging to a different customer.
//
// So every match must VERIFY. We read all plausible Shopify-identifier fields
// on each returned SC item and only accept a match when one actually equals
// the Shopify value we asked for. When Autososs ignores our filter, the
// response contains unrelated orders and verification correctly fails → null.
//
// Known Shopify-identifier fields on SC orders (from observation on Autososs):
//   OrderSourceOrderID                  — Shopify order_number (e.g. "311567")
//   ChannelOrderID / ChannelOrderID2    — sometimes holds the numeric Shopify id
//   EBaySellingManagerSalesRecordNumber — despite the name, sometimes holds the numeric Shopify id
//   CompletedOrderID                    — sometimes holds the Shopify name (e.g. "SS311567")
//
// We check all of them on every item. First verified match wins.

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
  const text = await res.text()
  if (!text) return undefined as unknown as T
  return JSON.parse(text) as T
}

// -------------- Order list pagination --------------

/**
 * Minimal SC order shape we actually read. SC returns ~71 fields per item;
 * we list the Shopify-identifier fields we check during matching and
 * TimeOfOrder for the pagination stop-condition.
 *
 * ChannelOrderID and related fields are declared optional+loose because SC
 * documentation is spotty about which are always present.
 */
export type ScListOrder = {
  ID: number
  TimeOfOrder: string
  CreatedOn: string
  OrderSourceOrderID: string | null
  EBaySellingManagerSalesRecordNumber?: string | null
  CompletedOrderID?: string | null
  ChannelOrderID?: string | null
  ChannelOrderID2?: string | null
  SecondaryOrderSourceOrderID?: string | null
  // Anything else SC returns is ignored — we pass through via JSON and index on the above.
  [key: string]: unknown
}

type ScListResponse = {
  Items?: ScListOrder[]
}

/**
 * Fetch one page of SC orders, newest first (SC default sort).
 * pageSize capped at 250.
 */
export async function listScOrders(page: number, pageSize = 250): Promise<ScListOrder[]> {
  const params = new URLSearchParams({
    'model.pageNumber': String(page),
    'model.pageSize': String(Math.min(pageSize, 250)),
  })
  const data = await scRequest<ScListResponse>(`/api/Orders?${params.toString()}`)
  return data.Items ?? []
}

// -------------- Verification: does a SC item actually match a Shopify order? --------------

/**
 * Read every plausible Shopify-identifier field off a SC order and return
 * the set of values it contains. Used for verification — we match iff one
 * of these equals a value we recognize.
 */
function scItemShopifyIdentifiers(item: ScListOrder): Set<string> {
  const out = new Set<string>()
  const candidates = [
    item.OrderSourceOrderID,
    item.EBaySellingManagerSalesRecordNumber,
    item.CompletedOrderID,
    item.ChannelOrderID,
    item.ChannelOrderID2,
    item.SecondaryOrderSourceOrderID,
  ]
  for (const v of candidates) {
    if (typeof v === 'string' && v.length > 0) out.add(v)
  }
  return out
}

/**
 * Does this SC item match a Shopify order with these identifiers?
 * Matches if any of the item's Shopify-identifier fields equals any of
 * the Shopify identifiers we're looking for. Prefix-stripped comparison
 * handles "SS311567" vs "311567".
 */
function scItemMatches(
  item: ScListOrder,
  target: {
    shopifyNumericId: string
    shopifyOrderNumber?: string | null
    shopifyName?: string | null
  },
): boolean {
  const itemIds = scItemShopifyIdentifiers(item)
  const wanted = new Set<string>()
  wanted.add(target.shopifyNumericId)
  if (target.shopifyOrderNumber) wanted.add(target.shopifyOrderNumber)
  if (target.shopifyName) {
    wanted.add(target.shopifyName)
    // Strip common prefix ("SS311567" -> "311567") so OrderSourceOrderID
    // comparisons work either way.
    const stripped = target.shopifyName.replace(/^[A-Za-z]+/, '')
    if (stripped) wanted.add(stripped)
  }

  for (const id of itemIds) {
    if (wanted.has(id)) return true
    // Also check prefix-stripped SC values (e.g. CompletedOrderID = "SS311567").
    const stripped = id.replace(/^[A-Za-z]+/, '')
    if (stripped && wanted.has(stripped)) return true
  }
  return false
}

// -------------- Targeted per-order lookup (verified) --------------

/**
 * Find the SC order for a Shopify order, verifying the match.
 *
 * Strategy:
 *   1. Ask SC for orders filtered by each of several field names.
 *   2. Iterate every returned item (not just items[0]).
 *   3. Verify at least one of the item's Shopify-identifier fields
 *      actually equals one of our target identifiers.
 *   4. Return the first verified match. If no item verifies, return null.
 *
 * This is safe against Autososs's filter-ignoring bug: if SC returns a
 * page of newest orders regardless of our filter, none of them will pass
 * verification for a random Shopify order, and we correctly return null.
 */
const SC_FILTER_FIELDS = [
  'OrderSourceOrderID',
  'EBaySellingManagerSalesRecordNumber',
  'ChannelOrderID',
  'CompletedOrderID',
] as const

export async function findScOrderByAnyShopifyId(identifiers: {
  shopifyNumericId: string | number
  shopifyOrderNumber?: string | number | null
  shopifyName?: string | null
}): Promise<{ ID: number; matchedOn: string } | null> {
  const shopifyNumericId = String(identifiers.shopifyNumericId)
  const shopifyOrderNumber = identifiers.shopifyOrderNumber
    ? String(identifiers.shopifyOrderNumber)
    : null
  const shopifyName = identifiers.shopifyName ?? null

  const target = { shopifyNumericId, shopifyOrderNumber, shopifyName }

  // What to send as the filter value for each field. The server may or may
  // not honor the filter; either way we verify client-side.
  const filterValueByField: Record<string, string | null> = {
    OrderSourceOrderID: shopifyOrderNumber,
    EBaySellingManagerSalesRecordNumber: shopifyNumericId,
    ChannelOrderID: shopifyNumericId,
    CompletedOrderID: shopifyName,
  }

  for (const field of SC_FILTER_FIELDS) {
    const filterValue = filterValueByField[field]
    if (!filterValue) continue

    try {
      const params = new URLSearchParams({
        [`model.${field}`]: filterValue,
        'model.pageNumber': '1',
        'model.pageSize': '50', // larger page means if filter is honored we catch it, if ignored we still scan the recent window
      })
      const data = await scRequest<ScListResponse>(`/api/Orders?${params.toString()}`)
      const items = data.Items ?? []

      for (const item of items) {
        if (scItemMatches(item, target)) {
          // Figure out which field on the item actually produced the match,
          // for logging/diagnostic purposes.
          const itemIds = scItemShopifyIdentifiers(item)
          const wanted = [
            shopifyNumericId,
            shopifyOrderNumber,
            shopifyName,
            shopifyName?.replace(/^[A-Za-z]+/, ''),
          ].filter(Boolean) as string[]
          let matchedOnField = 'unknown'
          for (const [key, value] of Object.entries(item)) {
            if (typeof value === 'string' && (wanted.includes(value) || wanted.includes(value.replace(/^[A-Za-z]+/, '')))) {
              matchedOnField = key
              break
            }
          }
          return { ID: item.ID, matchedOn: matchedOnField }
        }
      }
    } catch {
      // Move on to the next field if this one errors out.
    }
  }

  return null
}

// -------------- Targeted bulk backfill (verified) --------------

export type TargetedBackfillResult = {
  candidatesBefore: number
  checked: number
  matched: number
  matchedByField: Record<string, number>
  notFound: number
  candidatesRemaining: number
  errors: Array<{ orderNumber: string; error: string }>
}

export async function backfillScOrderIdsTargeted(options: {
  limit?: number
  scope?: 'dashboard' | 'all_recent'
} = {}): Promise<TargetedBackfillResult> {
  const limit = options.limit ?? 25
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
                 AND shopify_created_at > NOW() - INTERVAL '14 days')
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

  const [{ remaining }] =
    scope === 'dashboard'
      ? await sql<{ remaining: string }[]>`
          SELECT COUNT(*)::text AS remaining
          FROM shopify_orders
          WHERE sellercloud_order_id IS NULL
            AND (
              ((fulfillment_status IS NULL OR fulfillment_status != 'fulfilled')
               AND shopify_created_at < NOW() - INTERVAL '3 days'
               AND shopify_created_at > NOW() - INTERVAL '14 days')
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

// -------------- Pagination walk (verified) --------------

export type BackfillResult = {
  candidatesBefore: number
  pagesScanned: number
  matched: number
  candidatesRemaining: number
  stoppedReason: 'all_found' | 'page_cap' | 'walked_past_oldest' | 'empty_page'
}

/**
 * Walk SC orders newest-first and match each against our pending candidates.
 * Verification is done via scItemMatches (checks all plausible ID fields on
 * the item), so this is safe even if SC's order shape varies.
 */
export async function backfillScOrderIds(options: {
  scope?: 'dashboard' | 'all_recent'
  maxPages?: number
} = {}): Promise<BackfillResult> {
  const scope = options.scope ?? 'dashboard'
  const maxPages = options.maxPages ?? 40

    const candidates =
      scope === 'dashboard'
        ? await sql<{ id: string; order_number: string; raw_payload: any; shopify_created_at: Date }[]>`
            SELECT id::text, order_number, raw_payload, shopify_created_at
            FROM shopify_orders
            WHERE sellercloud_order_id IS NULL
              AND (
                ((fulfillment_status IS NULL OR fulfillment_status != 'fulfilled')
                 AND shopify_created_at < NOW() - INTERVAL '3 days'
                 AND shopify_created_at > NOW() - INTERVAL '14 days')
                OR
                (is_vip = TRUE AND shopify_created_at > NOW() - INTERVAL '7 days')
              )
          `

      : await sql<{ id: string; order_number: string; raw_payload: any; shopify_created_at: Date }[]>`
          SELECT id::text, order_number, raw_payload, shopify_created_at
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

  // Build a list of candidate targets keyed by shopify id for removal after match.
  const pending = new Map<
    string,
    {
      shopifyNumericId: string
      shopifyOrderNumber: string | null
      shopifyName: string | null
      createdAt: Date
    }
  >()
  let oldest = new Date()
  for (const c of candidates) {
    const shopifyName =
      typeof c.raw_payload?.name === 'string' ? c.raw_payload.name : null
    pending.set(c.id, {
      shopifyNumericId: c.id,
      shopifyOrderNumber: c.order_number,
      shopifyName,
      createdAt: new Date(c.shopify_created_at),
    })
    if (c.shopify_created_at < oldest) oldest = new Date(c.shopify_created_at)
  }

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
      // Check this SC item against every pending candidate. Typically O(1)
      // because most SC items share zero identifiers with our pending set.
      for (const [shopifyKey, target] of pending) {
        if (scItemMatches(item, target)) {
          try {
            await sql`
              UPDATE shopify_orders
              SET sellercloud_order_id = ${item.ID}, updated_at = NOW()
              WHERE id = ${shopifyKey}::bigint
                AND sellercloud_order_id IS NULL
            `
            matched += 1
            pending.delete(shopifyKey)
          } catch {
            // Swallow — don't let one bad row abort the whole walk.
          }
          break
        }
      }
    }

    if (pending.size === 0) {
      stoppedReason = 'all_found'
      break
    }

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

// -------------- Single-order resolver (used by action form) --------------

/**
 * Resolve a Shopify order to its SC counterpart. Fast path: DB cache.
 * Slow path: targeted verified lookup, with pagination fallback.
 */
const MAX_LIVE_PAGES = 10

export async function findScOrderByShopifyId(
  shopifyIdentifier: string | number,
): Promise<{ ID: number } | null> {
  const shopifyId = String(shopifyIdentifier)

  const cached = await sql<{ sellercloud_order_id: string | null; order_number: string; raw_payload: any }[]>`
    SELECT sellercloud_order_id::text, order_number, raw_payload
    FROM shopify_orders
    WHERE id = ${shopifyId}::bigint
    LIMIT 1
  `
  if (cached[0]?.sellercloud_order_id) {
    return { ID: parseInt(cached[0].sellercloud_order_id) }
  }

  const shopifyOrderNumber = cached[0]?.order_number ?? null
  const shopifyName =
    typeof cached[0]?.raw_payload?.name === 'string' ? cached[0].raw_payload.name : null

  // Try targeted first (usually one or two API calls).
  const targeted = await findScOrderByAnyShopifyId({
    shopifyNumericId: shopifyId,
    shopifyOrderNumber,
    shopifyName,
  })
  if (targeted) {
    await sql`
      UPDATE shopify_orders
      SET sellercloud_order_id = ${targeted.ID}, updated_at = NOW()
      WHERE id = ${shopifyId}::bigint
    `
    return { ID: targeted.ID }
  }

  // Fallback: walk pages, verifying every item.
  const target = {
    shopifyNumericId: shopifyId,
    shopifyOrderNumber,
    shopifyName,
  }
  for (let page = 1; page <= MAX_LIVE_PAGES; page++) {
    const items = await listScOrders(page, 250)
    if (items.length === 0) break

    const match = items.find((i) => scItemMatches(i, target))
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

// -------------- Order notes --------------

export async function addOrderNote(scOrderId: number | string, note: string) {
  await scRequest(`/api/Orders/${scOrderId}/Notes`, {
    method: 'POST',
    body: JSON.stringify({ Note: note }),
  })
  return { ok: true as const }
}

// -------------- Shipments --------------

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

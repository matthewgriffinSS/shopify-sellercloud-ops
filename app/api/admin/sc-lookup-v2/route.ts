import { NextRequest } from 'next/server'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Refined SC lookup diagnostic.
 *
 * Two goals in one request:
 *
 *   1. Filter discovery. Try several casings of the OrderSourceOrderId
 *      filter against the /api/Orders list endpoint. For each, check
 *      whether the FIRST returned SC order ID equals the expected ground
 *      truth. That proves the filter actually worked (as opposed to SC
 *      silently ignoring it and returning the 5 newest orders, which is
 *      what our earlier test was actually showing).
 *
 *   2. List shape inspection. Fetch /api/Orders with no filter and look
 *      at the top-level keys of the first two items. If OrderSourceOrderId
 *      (or a similar field holding the Shopify name) is present in the
 *      list response, we can do an efficient pagination-based backfill.
 *      If not, we'd have to GET each order individually.
 *
 * Usage:
 *   /api/admin/sc-lookup-v2?orderName=SS311729&expectedScId=5057494
 */

async function getToken(): Promise<string> {
  const baseUrl = process.env.SELLERCLOUD_API_URL
  const username = process.env.SELLERCLOUD_USERNAME
  const password = process.env.SELLERCLOUD_PASSWORD
  if (!baseUrl || !username || !password) {
    throw new Error('SELLERCLOUD_API_URL / USERNAME / PASSWORD not set')
  }
  const res = await fetch(`${baseUrl}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: username, Password: password }),
  })
  if (!res.ok) throw new Error(`SC auth failed: ${res.status}`)
  const { access_token } = (await res.json()) as { access_token: string }
  return access_token
}

async function scGet(path: string, token: string) {
  const baseUrl = process.env.SELLERCLOUD_API_URL
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = text.slice(0, 300)
  }
  return { ok: res.ok, status: res.status, body }
}

// All plausible param casings for the SC OrderSourceOrderId filter.
const FILTER_VARIANTS = [
  'orderSourceOrderId', // lowercase d (matches JSON field casing in GET-by-id)
  'orderSourceOrderID', // what we tried before (capital D + I)
  'OrderSourceOrderId', // PascalCase lowercase d
  'OrderSourceOrderID', // PascalCase
  'channelOrderId',
  'channelOrderID',
  'ChannelOrderId',
  'ChannelOrderID',
  'customerOrderId',
  'customerOrderID',
]

function isAuthed(req: NextRequest): boolean {
  const cookieValue = req.cookies.get('dashboard_auth')?.value
  return !process.env.DASHBOARD_PASSWORD || verifyCookieValue(cookieValue)
}

export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return new Response('Unauthorized', { status: 401 })
  try {
    const url = new URL(req.url)
    const orderName = url.searchParams.get('orderName')
    const expectedScIdStr = url.searchParams.get('expectedScId')
    if (!orderName || !expectedScIdStr) {
      return Response.json(
        {
          ok: false,
          error: 'Pass ?orderName=SS311729&expectedScId=5057494 (both required)',
        },
        { status: 400 },
      )
    }
    const expectedScId = parseInt(expectedScIdStr)

    const token = await getToken()

    // ----- PART 1: try every filter variant, validate against ground truth.
    type FilterAttempt = {
      param: string
      status: number
      resultCount: number
      firstId: number | null
      firstMatchesExpected: boolean
      allIds: number[]
      error: string | null
    }

    const filterAttempts: FilterAttempt[] = []
    for (const variant of FILTER_VARIANTS) {
      const params = new URLSearchParams({
        [`model.${variant}`]: orderName,
        'model.pageNumber': '1',
        'model.pageSize': '3',
      })
      try {
        const r = await scGet(`/api/Orders?${params.toString()}`, token)
        const body = r.body as { Items?: Array<{ ID?: number; OrderID?: number }> }
        const items = body?.Items ?? []
        const ids = items.map((i) => i.ID ?? i.OrderID ?? 0)
        filterAttempts.push({
          param: variant,
          status: r.status,
          resultCount: items.length,
          firstId: ids[0] ?? null,
          firstMatchesExpected: ids[0] === expectedScId,
          allIds: ids,
          error: r.ok ? null : JSON.stringify(r.body).slice(0, 200),
        })
      } catch (err) {
        filterAttempts.push({
          param: variant,
          status: 0,
          resultCount: 0,
          firstId: null,
          firstMatchesExpected: false,
          allIds: [],
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const workingFilters = filterAttempts.filter((a) => a.firstMatchesExpected)

    // If a filter genuinely works, resultCount should be 1 (exact match) or
    // very small. If we see resultCount == 3 (our pageSize), the filter was
    // likely ignored and we just got the 3 newest orders. Flag that as a
    // likely false positive.
    const likelyFalsePositives = filterAttempts.filter(
      (a) => a.resultCount === 3 && a.firstMatchesExpected === false,
    )

    // ----- PART 2: inspect unfiltered list shape so we know whether items
    // carry OrderSourceOrderId inline (fast bulk sync possible) or not
    // (would need per-item fetches, slower).
    const sample = await scGet(
      '/api/Orders?model.pageNumber=1&model.pageSize=2',
      token,
    )
    const sampleBody = sample.body as { Items?: Array<Record<string, unknown>> }
    const sampleItem = sampleBody?.Items?.[0] ?? null
    const sampleItemKeys = sampleItem ? Object.keys(sampleItem).sort() : []
    const hasOrderSourceOrderIdInline = sampleItemKeys.some(
      (k) => k.toLowerCase() === 'ordersourceorderid',
    )
    const hasOrderDetailsInline = sampleItemKeys.includes('OrderDetails')

    return Response.json({
      ok: true,
      groundTruth: { orderName, expectedScId },
      part1_filterDiscovery: {
        summary:
          workingFilters.length === 1
            ? `WINNER: model.${workingFilters[0].param} returns the correct SC ID (${expectedScId}) with resultCount=${workingFilters[0].resultCount}. Use this in findScOrderByShopifyId.`
            : workingFilters.length > 1
              ? `Multiple param names returned the expected SC ID. Pick the one where resultCount == 1 (exact match) rather than == 3 (filter ignored, just coincidence).`
              : 'No filter variant returned the expected SC ID. The list endpoint likely doesn\'t support filtering by OrderSourceOrderId, OR requires a different request format (POST body, different endpoint, etc).',
        workingFilters,
        likelyFalsePositives,
        allAttempts: filterAttempts,
      },
      part2_listShape: {
        summary: hasOrderSourceOrderIdInline
          ? 'List items include OrderSourceOrderId directly — bulk sync can match without per-item fetches. Fast path available.'
          : hasOrderDetailsInline
            ? 'List items include OrderDetails — OrderSourceOrderId should be at item.OrderDetails.OrderSourceOrderId. Fast path available.'
            : 'List items look like summaries — OrderSourceOrderId is NOT inline. Bulk sync would need a per-item GET /api/Orders/{id} for each, which is slow.',
        sampleItemKeyCount: sampleItemKeys.length,
        sampleItemKeys,
        sampleItemRaw: sampleItem,
      },
    })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

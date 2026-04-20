import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Diagnostic: given ONE Shopify order (by order_number, name, or id), tries
 * every plausible combination of SC filter field + Shopify ID format and
 * reports which one(s) return a match.
 *
 * Point this at an order you can also look up by hand in the SC web UI so
 * you can verify the returned SC ID is correct. Then use that (filter,
 * format) pair to fix findScOrderByShopifyId in lib/sellercloud.ts.
 *
 * Usage (while logged into the dashboard):
 *   /api/admin/sc-lookup-test?orderName=SS311729
 *   /api/admin/sc-lookup-test?orderNumber=306719
 *   /api/admin/sc-lookup-test?orderId=5123456789012
 *
 * Any one of those parameters is sufficient — we look up the row in Postgres
 * and pull the other identifiers from it.
 */

type ScOrder = { ID: number; [key: string]: unknown }
type ScListResponse = { Items?: ScOrder[] }

const FILTER_FIELDS = [
  'channelOrderID',
  'customerOrderID',
  'orderSourceOrderID',
] as const

type Attempt = {
  filter: string
  value: string
  label: string
  matched: boolean
  scOrderId: number | null
  resultCount: number
  error: string | null
}

async function scRequestRaw(path: string): Promise<unknown> {
  // Inlined minimal SC request so we don't have to extend lib/sellercloud.ts
  // just for this diagnostic. Uses the same token-caching flow that
  // lib/sellercloud.ts uses in production — this is a parallel path only
  // for trying raw filter names.
  const baseUrl = process.env.SELLERCLOUD_API_URL
  const username = process.env.SELLERCLOUD_USERNAME
  const password = process.env.SELLERCLOUD_PASSWORD
  if (!baseUrl || !username || !password) {
    throw new Error('SELLERCLOUD_API_URL / USERNAME / PASSWORD not set')
  }

  const tokenRes = await fetch(`${baseUrl}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: username, Password: password }),
  })
  if (!tokenRes.ok) {
    throw new Error(`SC auth failed: ${tokenRes.status}`)
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string }

  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${access_token}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    throw new Error(`SC ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : {}
}

async function tryLookup(filter: string, value: string): Promise<Attempt> {
  const params = new URLSearchParams({
    [`model.${filter}`]: value,
    'model.pageNumber': '1',
    'model.pageSize': '5',
  })
  try {
    const data = (await scRequestRaw(`/api/Orders?${params.toString()}`)) as ScListResponse
    const items = data.Items ?? []
    return {
      filter,
      value,
      label: `${filter}=${value}`,
      matched: items.length > 0,
      scOrderId: items[0]?.ID ?? null,
      resultCount: items.length,
      error: null,
    }
  } catch (err) {
    return {
      filter,
      value,
      label: `${filter}=${value}`,
      matched: false,
      scOrderId: null,
      resultCount: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function runDiagnostic(params: {
  orderName?: string
  orderNumber?: string
  orderId?: string
}) {
  // Look the order up in our DB so we have all three identifiers handy.
  const rows = await sql<
    {
      id: string
      order_number: string
      name: string | null
      customer_name: string | null
    }[]
  >`
    SELECT id::text, order_number,
           raw_payload->>'name' AS name,
           customer_name
    FROM shopify_orders
    WHERE
      ${params.orderName ?? null}::text IS NOT NULL AND raw_payload->>'name' = ${params.orderName ?? null}
      OR ${params.orderNumber ?? null}::text IS NOT NULL AND order_number = ${params.orderNumber ?? null}
      OR ${params.orderId ?? null}::text IS NOT NULL AND id = ${params.orderId ?? null}::bigint
    LIMIT 1
  `

  if (rows.length === 0) {
    return Response.json(
      {
        ok: false,
        error: `No order in shopify_orders matching those identifiers. Pass ?orderName=SS311729 or ?orderNumber=306719 or ?orderId=<shopify internal id>. If the order is recent, try running the late-fulfillment scan first to pull it in.`,
      },
      { status: 404 },
    )
  }

  const row = rows[0]
  const candidateValues = [
    { label: 'shopify id (numeric)', value: row.id },
    { label: 'order_number', value: row.order_number },
    ...(row.name ? [{ label: 'name (prefixed)', value: row.name }] : []),
    ...(row.name
      ? [{ label: 'name without leading #', value: row.name.replace(/^#/, '') }]
      : []),
  ]

  const attempts: Attempt[] = []
  for (const field of FILTER_FIELDS) {
    for (const candidate of candidateValues) {
      const result = await tryLookup(field, candidate.value)
      result.label = `${field} = ${candidate.value} (${candidate.label})`
      attempts.push(result)
    }
  }

  const matches = attempts.filter((a) => a.matched)
  const errored = attempts.filter((a) => a.error !== null)

  return Response.json({
    ok: true,
    order: {
      shopifyId: row.id,
      orderNumber: row.order_number,
      name: row.name,
      customerName: row.customer_name,
    },
    summary:
      matches.length === 0
        ? 'NO MATCHES. SC may not have this order yet, or the channel integration uses a different field entirely.'
        : matches.length === 1
          ? `Found exactly one working combination: ${matches[0].label} → SC order ID ${matches[0].scOrderId}. Verify this matches the SC UI for this order, then update findScOrderByShopifyId.`
          : `Multiple combinations matched. Pick the one whose SC order ID matches what you see in the SC web UI, then update findScOrderByShopifyId to use that (filter, format) pair.`,
    matches,
    errored,
    allAttempts: attempts,
  })
}

function isAuthed(req: NextRequest): boolean {
  const cookieValue = req.cookies.get('dashboard_auth')?.value
  return !process.env.DASHBOARD_PASSWORD || verifyCookieValue(cookieValue)
}

export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return new Response('Unauthorized', { status: 401 })
  try {
    const url = new URL(req.url)
    const orderName = url.searchParams.get('orderName') ?? undefined
    const orderNumber = url.searchParams.get('orderNumber') ?? undefined
    const orderId = url.searchParams.get('orderId') ?? undefined

    if (!orderName && !orderNumber && !orderId) {
      return Response.json(
        {
          ok: false,
          error:
            'Pass one of: ?orderName=SS311729, ?orderNumber=306719, or ?orderId=<shopify internal id>',
        },
        { status: 400 },
      )
    }

    return await runDiagnostic({ orderName, orderNumber, orderId })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

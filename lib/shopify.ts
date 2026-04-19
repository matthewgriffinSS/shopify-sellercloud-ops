import crypto from 'node:crypto'

/**
 * Verify a Shopify webhook signature.
 * Must be called against the *raw request body*, not a parsed JSON object.
 */
export function verifyShopifyWebhook(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false
  if (!secret) return false

  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64')

  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// ---------- Shopify token management via client_credentials grant ----------

// Module-level cache persists across warm serverless invocations.
// Tokens from client_credentials are typically valid ~1 hour.
let cachedToken: string | null = null
let cachedAt = 0
let inflight: Promise<string> | null = null
const TOKEN_TTL_MS = 50 * 60 * 1000 // 50 min, with safety margin

/**
 * Mint (or reuse) a Shopify Admin API token via the client_credentials grant.
 * This is the "app-only" auth flow used by custom distribution apps —
 * no user interaction, no install redirect. Client ID + secret → token.
 */
async function getAccessToken(): Promise<string> {
  const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE_DOMAIN } = process.env
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SHOPIFY_STORE_DOMAIN) {
    throw new Error('Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET / SHOPIFY_STORE_DOMAIN')
  }

  const now = Date.now()
  if (cachedToken && now - cachedAt < TOKEN_TTL_MS) {
    return cachedToken
  }

  // Dedupe concurrent cold fetches
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${encodeURIComponent(
          SHOPIFY_CLIENT_ID,
        )}&client_secret=${encodeURIComponent(SHOPIFY_CLIENT_SECRET)}`,
      })
      if (!res.ok) {
        throw new Error(`Shopify token exchange failed: ${res.status} ${await res.text()}`)
      }
      const data = (await res.json()) as { access_token?: string }
      if (!data.access_token) throw new Error('Shopify did not return an access_token')
      cachedToken = data.access_token
      cachedAt = Date.now()
      return cachedToken
    } finally {
      inflight = null
    }
  })()

  return inflight
}

const API_VERSION = '2025-01'

/**
 * Minimal Shopify Admin API client. Throws on non-2xx responses.
 * Gets a fresh token automatically if needed.
 */
export async function shopifyRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const { body } = await shopifyRequestRaw<T>(path, init)
  return body
}

/**
 * Like shopifyRequest but also returns the Link header — needed for
 * paginating list endpoints. Shopify's REST pagination is cursor-based:
 * response has `Link: <...?page_info=xyz>; rel="next"`.
 * See: https://shopify.dev/docs/api/usage/pagination-rest
 */
export async function shopifyRequestRaw<T>(
  path: string,
  init?: RequestInit,
): Promise<{ body: T; linkHeader: string | null }> {
  const token = await getAccessToken()
  const res = await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}${path}`,
    {
      ...init,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Shopify ${path}: ${res.status} ${body}`)
  }
  const body = (await res.json()) as T
  return { body, linkHeader: res.headers.get('link') }
}

/**
 * Extract the page_info cursor from a Shopify Link header.
 * Returns null if there's no next page.
 */
export function parseNextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  // Format: <https://store.myshopify.com/admin/api/2025-01/draft_orders.json?page_info=xyz&limit=250>; rel="next", <...>; rel="previous"
  const parts = linkHeader.split(',')
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/)
    if (match) {
      try {
        const url = new URL(match[1])
        return url.searchParams.get('page_info')
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * Fetch a list of orders currently unfulfilled and older than N days.
 * Used by the late-fulfillment cron job.
 */
export async function fetchStaleUnfulfilledOrders(daysOld: number) {
  const cutoff = new Date(Date.now() - daysOld * 86_400_000).toISOString()
  const params = new URLSearchParams({
    status: 'open',
    fulfillment_status: 'unfulfilled',
    created_at_max: cutoff,
    limit: '250',
  })
  return shopifyRequest<{ orders: ShopifyOrder[] }>(`/orders.json?${params.toString()}`)
}

// Minimal Shopify order shape we actually read in this app.
export type ShopifyOrder = {
  id: number
  order_number: number
  email: string | null
  total_price: string
  currency: string
  financial_status: string | null
  fulfillment_status: string | null
  source_name: string | null
  tags: string // comma-separated
  created_at: string
  customer: { first_name: string | null; last_name: string | null } | null
}

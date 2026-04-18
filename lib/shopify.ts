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

  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64')

  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

const STORE = process.env.SHOPIFY_STORE_DOMAIN
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN
const API_VERSION = '2025-01'

/**
 * Minimal Shopify Admin API client. Throws on non-2xx responses.
 */
export async function shopifyRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (!STORE || !TOKEN) {
    throw new Error('SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_API_TOKEN is not set')
  }

  const res = await fetch(`https://${STORE}/admin/api/${API_VERSION}${path}`, {
    ...init,
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Shopify ${path}: ${res.status} ${body}`)
  }
  return res.json() as Promise<T>
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

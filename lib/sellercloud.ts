// Sellercloud REST API client — configured for Autososs (autososs.api.sellercloud.us)
//
// Auth: JWT via POST /rest/api/token with { Username, Password } body.
// Token is valid for 60 minutes per Sellercloud docs. We cache for 50 minutes
// with a safety margin and use inflight deduplication for cold-start races.
//
// All request paths below use the /rest/api/... prefix documented in Sellercloud's
// Swagger. Visit https://autososs.api.sellercloud.us/rest/swagger/ui/ to browse them.

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

// -------------- Order lookup --------------

/**
 * Find Sellercloud order(s) matching a Shopify order number or ID.
 * Uses the Get All Orders endpoint with a ChannelOrderID filter, which is
 * how most Sellercloud-Shopify integrations store the link.
 *
 * Returns the first match, or null if none found.
 *
 * NOTE: Field name may differ depending on how your SC-Shopify channel is
 * configured. If this returns null unexpectedly, open Swagger at
 * https://autososs.api.sellercloud.us/rest/swagger/ui/ and check the
 * GET /api/Orders parameter list for the right filter param name
 * (likely one of: ChannelOrderID, CustomerOrderID, or OrderSourceOrderID).
 */
export async function findScOrderByShopifyId(shopifyIdentifier: string | number) {
  const params = new URLSearchParams({
    'model.channelOrderID': String(shopifyIdentifier),
    'model.pageNumber': '1',
    'model.pageSize': '10',
  })
  const data = await scRequest<{ Items: Array<{ ID: number }> }>(
    `/api/Orders?${params.toString()}`,
  )
  return data.Items?.[0] ?? null
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

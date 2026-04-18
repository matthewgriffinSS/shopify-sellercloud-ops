// Sellercloud API client.
//
// IMPORTANT: Sellercloud exposes multiple APIs and endpoint paths differ between
// instances (Legacy SOAP vs newer REST, self-hosted vs SaaS). The endpoint paths
// below are plausible defaults — verify them against your specific SC instance
// docs before shipping. The auth flow here follows SC's token-auth pattern.

type TokenResponse = { access_token: string; expires_in: number }

let cachedToken: { token: string; expiresAt: number } | null = null

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token
  }

  const url = process.env.SELLERCLOUD_API_URL
  if (!url) throw new Error('SELLERCLOUD_API_URL is not set')

  const res = await fetch(`${url}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Username: process.env.SELLERCLOUD_USERNAME,
      Password: process.env.SELLERCLOUD_PASSWORD,
    }),
  })
  if (!res.ok) {
    throw new Error(`Sellercloud auth failed: ${res.status} ${await res.text()}`)
  }
  const data = (await res.json()) as TokenResponse
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
  return cachedToken.token
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
  return res.json() as Promise<T>
}

/**
 * Find the Sellercloud order by its Shopify order ID.
 * Most SC integrations store the Shopify ID as external ID on the SC order.
 * Adjust query params to match your SC field mapping.
 */
export async function findScOrderByShopifyId(shopifyOrderId: string | number) {
  const params = new URLSearchParams({ ExternalOrderId: String(shopifyOrderId) })
  const data = await scRequest<{ Items: Array<{ ID: string }> }>(
    `/api/Orders?${params.toString()}`,
  )
  return data.Items?.[0] ?? null
}

/**
 * Post a note / memo onto a Sellercloud order.
 * Returns the SC note ID so we can audit-link it to our processing_actions row.
 */
export async function addOrderNote(scOrderId: string, note: string, user = 'ops-dashboard') {
  return scRequest<{ ID: string }>(`/api/Orders/${scOrderId}/Notes`, {
    method: 'POST',
    body: JSON.stringify({ Note: note, CreatedBy: user }),
  })
}

/**
 * Mark an order as shipped in Sellercloud and record tracking.
 */
export async function createShipment(
  scOrderId: string,
  input: { carrier: string; tracking: string; note?: string },
) {
  return scRequest<{ ID: string }>(`/api/Orders/${scOrderId}/Shipments`, {
    method: 'POST',
    body: JSON.stringify({
      Carrier: input.carrier,
      TrackingNumber: input.tracking,
      Note: input.note ?? '',
    }),
  })
}

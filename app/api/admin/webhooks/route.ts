import { NextRequest } from 'next/server'
import { shopifyRequest } from '@/lib/shopify'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Webhook = {
  id: number
  topic: string
  address: string
  format: string
  created_at: string
  updated_at: string
}

const REQUIRED_WEBHOOKS = [
  { topic: 'orders/create', path: '/api/webhooks/shopify/orders-create' },
  { topic: 'orders/updated', path: '/api/webhooks/shopify/orders-updated' },
  { topic: 'draft_orders/create', path: '/api/webhooks/shopify/draft-orders-create' },
  { topic: 'draft_orders/update', path: '/api/webhooks/shopify/draft-orders-create' },
  { topic: 'checkouts/update', path: '/api/webhooks/shopify/checkouts-abandoned' },
]

function requireAuth(req: NextRequest) {
  const cookieValue = req.cookies.get('dashboard_auth')?.value
  if (process.env.DASHBOARD_PASSWORD && !verifyCookieValue(cookieValue)) {
    return new Response('Unauthorized', { status: 401 })
  }
  return null
}

/**
 * GET /api/admin/webhooks
 * Lists all webhooks currently registered on the Shopify store and reports
 * which of our required topics are missing or misconfigured.
 */
export async function GET(req: NextRequest) {
  const unauth = requireAuth(req)
  if (unauth) return unauth

  try {
    const { webhooks } = await shopifyRequest<{ webhooks: Webhook[] }>('/webhooks.json?limit=250')
    const origin = req.nextUrl.origin

    const status = REQUIRED_WEBHOOKS.map((req) => {
      const match = webhooks.find(
        (w) => w.topic === req.topic && w.address === `${origin}${req.path}`,
      )
      const wrongAddress = webhooks.find(
        (w) => w.topic === req.topic && w.address !== `${origin}${req.path}`,
      )
      return {
        topic: req.topic,
        expectedAddress: `${origin}${req.path}`,
        registered: !!match,
        webhookId: match?.id ?? null,
        wrongAddress: wrongAddress ? wrongAddress.address : null,
      }
    })

    return Response.json({
      ok: true,
      totalWebhooks: webhooks.length,
      required: status,
      allWebhooks: webhooks.map((w) => ({ id: w.id, topic: w.topic, address: w.address })),
    })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

/**
 * POST /api/admin/webhooks
 * Registers any required webhooks that are missing. Idempotent — safe to re-run.
 */
export async function POST(req: NextRequest) {
  const unauth = requireAuth(req)
  if (unauth) return unauth

  const origin = req.nextUrl.origin
  const results: Array<{ topic: string; ok: boolean; detail: string }> = []

  try {
    const { webhooks } = await shopifyRequest<{ webhooks: Webhook[] }>('/webhooks.json?limit=250')

    for (const required of REQUIRED_WEBHOOKS) {
      const expectedAddress = `${origin}${required.path}`
      const existing = webhooks.find(
        (w) => w.topic === required.topic && w.address === expectedAddress,
      )

      if (existing) {
        results.push({ topic: required.topic, ok: true, detail: 'Already registered' })
        continue
      }

      // Delete any existing webhook for this topic pointing at a different address
      // (e.g. old deploy URL) before registering the new one.
      const stale = webhooks.find((w) => w.topic === required.topic)
      if (stale) {
        try {
          await shopifyRequest(`/webhooks/${stale.id}.json`, { method: 'DELETE' })
        } catch {
          // Ignore delete failure — Shopify won't let us have two at same topic+address
        }
      }

      try {
        await shopifyRequest('/webhooks.json', {
          method: 'POST',
          body: JSON.stringify({
            webhook: { topic: required.topic, address: expectedAddress, format: 'json' },
          }),
        })
        results.push({ topic: required.topic, ok: true, detail: 'Registered' })
      } catch (err) {
        results.push({
          topic: required.topic,
          ok: false,
          detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
        })
      }
    }

    return Response.json({ ok: true, results })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

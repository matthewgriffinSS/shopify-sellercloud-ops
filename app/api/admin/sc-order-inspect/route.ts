import { NextRequest } from 'next/server'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * Diagnostic: fetches a single Sellercloud order by its SC ID and returns
 * the full payload. Use this to figure out which field on the SC order
 * stores the Shopify identifier — then we know what field name to pass to
 * findScOrderByShopifyId.
 *
 * Usage (while logged into the dashboard):
 *   /api/admin/sc-order-inspect?scOrderId=5057494
 *
 * Also tries a few alternative endpoints in case the /api/Orders/{id} path
 * isn't the right one on this SC instance.
 *
 * Also does a targeted search: given the Shopify name you expect (e.g.
 * "SS311729"), walks the returned SC order payload looking for any field
 * whose value matches. That tells us the exact JSON path we should filter on.
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

async function scGet(path: string, token: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const baseUrl = process.env.SELLERCLOUD_API_URL
  try {
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
      body = text.slice(0, 500)
    }
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Walk an object tree looking for any leaf value that equals (or contains)
 * the target string. Returns every matching path so we can see which field(s)
 * are candidates for the filter we need to write.
 */
function findMatchingPaths(obj: unknown, target: string, prefix = ''): string[] {
  if (obj === null || obj === undefined) return []
  if (typeof obj === 'string' || typeof obj === 'number') {
    const str = String(obj)
    if (str === target) return [`${prefix} (exact match: "${str}")`]
    if (str.includes(target) && target.length >= 4) {
      return [`${prefix} (contains: "${str}")`]
    }
    return []
  }
  if (Array.isArray(obj)) {
    return obj.flatMap((item, i) => findMatchingPaths(item, target, `${prefix}[${i}]`))
  }
  if (typeof obj === 'object') {
    return Object.entries(obj).flatMap(([key, value]) =>
      findMatchingPaths(value, target, prefix ? `${prefix}.${key}` : key),
    )
  }
  return []
}

function isAuthed(req: NextRequest): boolean {
  const cookieValue = req.cookies.get('dashboard_auth')?.value
  return !process.env.DASHBOARD_PASSWORD || verifyCookieValue(cookieValue)
}

export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return new Response('Unauthorized', { status: 401 })
  try {
    const url = new URL(req.url)
    const scOrderId = url.searchParams.get('scOrderId')
    const expectShopifyName = url.searchParams.get('expect') ?? undefined

    if (!scOrderId) {
      return Response.json(
        {
          ok: false,
          error:
            'Pass ?scOrderId=5057494 (the ID from the SC URL bar). Optionally add &expect=SS311729 to auto-locate fields holding that value.',
        },
        { status: 400 },
      )
    }

    const token = await getToken()

    // Try every plausible endpoint path. SC's Delta API varies by instance —
    // we want to see which actually works before committing to one in code.
    const paths = [
      `/api/Orders/${scOrderId}`,
      `/api/Order/${scOrderId}`,
      `/api/Orders/${scOrderId}/Details`,
    ]

    const attempts: Array<{ path: string; status: number; ok: boolean; keys: string[] | null; body?: unknown }> = []
    let successBody: unknown = null
    let successPath: string | null = null

    for (const path of paths) {
      const result = await scGet(path, token)
      const keys =
        result.ok && result.body && typeof result.body === 'object' && !Array.isArray(result.body)
          ? Object.keys(result.body as Record<string, unknown>)
          : null
      attempts.push({ path, status: result.status, ok: result.ok, keys })
      if (result.ok && successBody === null) {
        successBody = result.body
        successPath = path
        attempts[attempts.length - 1].body = result.body
      }
    }

    let matchingPaths: string[] = []
    if (successBody && expectShopifyName) {
      matchingPaths = findMatchingPaths(successBody, expectShopifyName)
    }

    return Response.json({
      ok: !!successBody,
      scOrderId,
      successPath,
      attempts: attempts.map((a) => ({
        path: a.path,
        status: a.status,
        ok: a.ok,
        keyCount: a.keys?.length ?? null,
        topLevelKeys: a.keys?.slice(0, 40) ?? null,
      })),
      expectShopifyName: expectShopifyName ?? null,
      fieldsContainingExpected: matchingPaths,
      fullOrderBody: successBody,
      summary:
        !successBody
          ? 'No endpoint variant worked. Check Swagger at https://autososs.api.sellercloud.us/rest/swagger/ui/ for the correct path.'
          : matchingPaths.length > 0
            ? `Found the Shopify identifier at: ${matchingPaths.join(', ')}. That field is what we should filter on.`
            : expectShopifyName
              ? `Fetched the SC order OK but no field contained "${expectShopifyName}". Scan fullOrderBody below for the right value — it might be stored under a different form (numeric Shopify ID, order number without prefix, etc).`
              : 'Fetched the SC order OK. Pass &expect=<shopify-order-name> to auto-locate the Shopify identifier field.',
    })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

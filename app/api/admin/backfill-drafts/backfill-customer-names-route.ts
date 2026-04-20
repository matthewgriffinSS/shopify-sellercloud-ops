import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Backfills customer_name (and customer_email as a bonus) on shopify_orders
 * by pulling values out of the raw_payload JSONB column.
 *
 * Runs once to fix rows that were first seen via orders/updated before the
 * customer_name fix landed — those went in with NULL customer_name and
 * never got repaired by later updates. This endpoint is effectively the
 * code version of db/migrations/002_backfill_customer_name.sql, so you
 * don't have to open the Neon SQL Editor to fix the display.
 *
 * Safe to re-run. Only touches NULL rows where raw_payload has the data.
 */
async function runBackfill() {
  const beforeRows = await sql<{ missing: string; total: string }[]>`
    SELECT
      COUNT(*) FILTER (WHERE customer_name IS NULL)::text AS missing,
      COUNT(*)::text AS total
    FROM shopify_orders
    WHERE (fulfillment_status IS NULL OR fulfillment_status != 'fulfilled')
      AND shopify_created_at < NOW() - INTERVAL '3 days'
  `
  const before = beforeRows[0]

  // Fill customer_name from raw_payload.customer.{first_name,last_name}.
  // COALESCE/NULLIF/TRIM together ensure that we don't write back an empty
  // string if both first and last are missing.
  const nameResult = await sql<{ id: string }[]>`
    UPDATE shopify_orders
    SET customer_name = NULLIF(
          TRIM(
            COALESCE(raw_payload->'customer'->>'first_name', '') || ' ' ||
            COALESCE(raw_payload->'customer'->>'last_name', '')
          ),
          ''
        ),
        updated_at = NOW()
    WHERE customer_name IS NULL
      AND raw_payload->'customer' IS NOT NULL
    RETURNING id::text
  `

  // Same treatment for customer_email.
  const emailResult = await sql<{ id: string }[]>`
    UPDATE shopify_orders
    SET customer_email = raw_payload->>'email',
        updated_at = NOW()
    WHERE customer_email IS NULL
      AND raw_payload->>'email' IS NOT NULL
      AND raw_payload->>'email' != ''
    RETURNING id::text
  `

  const afterRows = await sql<{ missing: string; total: string }[]>`
    SELECT
      COUNT(*) FILTER (WHERE customer_name IS NULL)::text AS missing,
      COUNT(*)::text AS total
    FROM shopify_orders
    WHERE (fulfillment_status IS NULL OR fulfillment_status != 'fulfilled')
      AND shopify_created_at < NOW() - INTERVAL '3 days'
  `
  const after = afterRows[0]

  return Response.json({
    ok: true,
    namesUpdated: nameResult.length,
    emailsUpdated: emailResult.length,
    lateMissingBefore: parseInt(before.missing),
    lateMissingAfter: parseInt(after.missing),
    lateTotal: parseInt(after.total),
    note:
      parseInt(after.missing) === 0
        ? 'All late orders now have customer names.'
        : `${after.missing} late orders still have NULL customer_name — these are guest checkouts with no customer block on the order, or orders from before we started storing raw_payload.`,
  })
}

function isAuthed(req: NextRequest): boolean {
  const cookieValue = req.cookies.get('dashboard_auth')?.value
  return !process.env.DASHBOARD_PASSWORD || verifyCookieValue(cookieValue)
}

export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return new Response('Unauthorized', { status: 401 })
  try {
    return await runBackfill()
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  return GET(req)
}

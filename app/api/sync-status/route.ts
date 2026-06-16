import { NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/sync-status
 *
 * One small payload powering the HeaderTools widget:
 *   - lastRun: the most recent sync_runs row (or null before the first run)
 *   - reps: distinct rep names pulled from draft assignments, used for the
 *     "I am" picker. Zero configuration — whoever shows up in Shopify draft
 *     tags shows up here.
 *
 * Dashboard-cookie auth only; there's no cron use for this route.
 */
export async function GET(req: NextRequest) {
  const cookieValue = req.cookies.get('dashboard_auth')?.value
  if (process.env.DASHBOARD_PASSWORD && !verifyCookieValue(cookieValue)) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    const lastRuns = await sql<
      {
        ran_at: Date
        ok: boolean
        triggered_by: string | null
        elapsed_ms: number | null
        error: string | null
      }[]
    >`
      SELECT ran_at, ok, triggered_by, elapsed_ms, error
      FROM sync_runs
      ORDER BY ran_at DESC
      LIMIT 1
    `

    const repRows = await sql<{ assigned_rep: string }[]>`
      SELECT DISTINCT assigned_rep
      FROM shopify_draft_orders
      WHERE assigned_rep IS NOT NULL AND assigned_rep != ''
      ORDER BY assigned_rep
    `

    const last = lastRuns[0]
    return Response.json({
      ok: true,
      lastRun: last
        ? {
            ranAt: last.ran_at.toISOString(),
            ok: last.ok,
            triggeredBy: last.triggered_by,
            elapsedMs: last.elapsed_ms,
            error: last.error,
          }
        : null,
      reps: repRows.map((r) => r.assigned_rep),
    })
  } catch (err) {
    // Most likely cause: migration 003 hasn't been run yet, so sync_runs
    // doesn't exist. The widget shows "Sync status unavailable" for this.
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

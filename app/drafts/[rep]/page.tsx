import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireDashboardAuth } from '@/lib/auth'
import { fetchDraftsForRep } from '@/lib/queries'
import { KNOWN_REPS } from '@/lib/tags'
import { DraftFollowupTable } from '@/app/components/DraftFollowupTable'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const VALID_REPS = new Set<string>([...KNOWN_REPS, 'unassigned'])

/**
 * Per-rep drafts page. Replaces the rep-named tabs in the old
 * "Draft Order Follow Up" Google Sheet. URL is /drafts/<rep>.
 *
 * Accessible only to authenticated dashboard users, but note that any
 * authed user can view any rep's page — this matches the old sheet
 * where all tabs were visible to anyone with access. Add per-rep
 * access control later if needed.
 */
export default async function RepDraftsPage({
  params,
}: {
  params: Promise<{ rep: string }>
}) {
  await requireDashboardAuth()

  const { rep: repParam } = await params
  const rep = repParam.toLowerCase()
  if (!VALID_REPS.has(rep)) notFound()

  const rows = await fetchDraftsForRep(rep)
  const title = rep === 'unassigned' ? 'Unassigned' : rep.charAt(0).toUpperCase() + rep.slice(1)

  return (
    <>
      <div className="header">
        <div className="brand">
          <span className="logo">OPS</span>
          <div className="divider"></div>
          <div>
            <div className="title">{title} · drafts</div>
            <div className="meta">
              {rows.length} open draft{rows.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link href="/" className="icon-btn">
            ← Dashboard
          </Link>
        </div>
      </div>

      <main className="container">
        <div className="card">
          <h3>Draft follow-up · {title}</h3>
          <DraftFollowupTable rows={rows} />
        </div>

        <div className="footer">
          Drafts with service tags (sdss / install / rebuild / shock service) are excluded from this
          view.
        </div>
      </main>
    </>
  )
}

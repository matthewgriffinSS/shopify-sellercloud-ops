import {
  fetchAbandonedCarts,
  recentNotesForResources,
  statusMapForResources,
} from '@/lib/queries'
import { AbandonedCartsGrid } from './AbandonedCartsGrid'

export async function AbandonedCarts() {
  const rows = await fetchAbandonedCarts()
  const ids = rows.map((r) => r.id)
  const [notes, statusMap] = await Promise.all([
    recentNotesForResources('abandoned_checkout', ids),
    statusMapForResources('abandoned_checkout', ids),
  ])

  // Carts with a terminal action are filtered out of the query, so anything
  // in statusMap is in_progress (e.g. has an add_note).
  const inProgress: Record<string, boolean> = {}
  for (const [id, st] of statusMap) {
    if (st && st.status === 'in_progress') inProgress[id] = true
  }

  const initialRows = rows.map((r) => ({
    ...r,
    abandoned_at: r.abandoned_at.toISOString(),
    contacted_at: r.contacted_at ? r.contacted_at.toISOString() : null,
  }))

  return (
    <div className="card">
      <h3>High-value abandoned carts ($2000+)</h3>
      <AbandonedCartsGrid
        initialRows={initialRows}
        initialNotes={notes}
        initialInProgress={inProgress}
      />
    </div>
  )
}

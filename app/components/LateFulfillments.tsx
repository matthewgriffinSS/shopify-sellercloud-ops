import {
  fetchLateFulfillments,
  recentNotesForResources,
  statusMapForResources,
} from '@/lib/queries'
import { OrdersTable } from './OrdersTable'

export async function LateFulfillments() {
  const rows = await fetchLateFulfillments()
  const ids = rows.map((r) => r.id)
  const [notes, statusMap] = await Promise.all([
    recentNotesForResources('order', ids),
    statusMapForResources('order', ids),
  ])

  // Status map already excludes processed orders (filtered at query level),
  // so anything in it is in_progress (i.e. has a non-terminal action like add_note).
  const inProgress: Record<string, boolean> = {}
  for (const [id, st] of statusMap) {
    if (st && st.status === 'in_progress') inProgress[id] = true
  }

  // JSON-serialize Date fields so they survive the server→client boundary.
  const initialRows = rows.map((r) => ({
    ...r,
    shopify_created_at: r.shopify_created_at.toISOString(),
  }))

  return (
    <div className="card">
      <h3>Late fulfillments</h3>
      <OrdersTable
        variant="late"
        initialRows={initialRows}
        initialNotes={notes}
        initialInProgress={inProgress}
        storeDomain={process.env.SHOPIFY_STORE_DOMAIN ?? null}
        scAdminUrl={process.env.SELLERCLOUD_ADMIN_URL ?? null}
      />
    </div>
  )
}

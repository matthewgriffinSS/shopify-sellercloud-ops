import {
  fetchVipOrders,
  recentNotesForResources,
  statusMapForResources,
} from '@/lib/queries'
import { OrdersTable } from './OrdersTable'

export async function VipOrders() {
  const rows = await fetchVipOrders()
  const ids = rows.map((r) => r.id)
  const [notes, statusMap] = await Promise.all([
    recentNotesForResources('order', ids),
    statusMapForResources('order', ids),
  ])

  const inProgress: Record<string, boolean> = {}
  for (const [id, st] of statusMap) {
    if (st && st.status === 'in_progress') inProgress[id] = true
  }

  const initialRows = rows.map((r) => ({
    ...r,
    shopify_created_at: r.shopify_created_at.toISOString(),
  }))

  return (
    <div className="card">
      <h3>VIP orders — this week</h3>
      <OrdersTable
        variant="vip"
        initialRows={initialRows}
        initialNotes={notes}
        initialInProgress={inProgress}
        storeDomain={process.env.SHOPIFY_STORE_DOMAIN ?? null}
        scAdminUrl={process.env.SELLERCLOUD_ADMIN_URL ?? null}
      />
    </div>
  )
}

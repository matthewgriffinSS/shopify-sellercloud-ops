import { Suspense } from 'react'
import { requireDashboardAuth } from '@/lib/auth'
import { Metrics } from './components/Metrics'
import { LateFulfillments } from './components/LateFulfillments'
import { VipOrders } from './components/VipOrders'
import { DraftsByRep } from './components/DraftsByRep'
import { AbandonedCarts } from './components/AbandonedCarts'

// Always fetch fresh data — this dashboard is the source of truth for "what needs action".
export const dynamic = 'force-dynamic'
export const revalidate = 0

function Loading() {
  return <div className="empty">Loading…</div>
}

export default async function DashboardPage() {
  // Redirects to /login if DASHBOARD_PASSWORD is set and user isn't authed.
  // No-op if DASHBOARD_PASSWORD is unset (useful for local dev).
  await requireDashboardAuth()

  return (
    <main className="container">
      <header className="hdr">
        <div>
          <h1 className="ttl">Operations dashboard</h1>
          <p className="sub">Shopify + Sellercloud · orders requiring action</p>
        </div>
        <div className="status-row">
          <span>
            <span className="dot"></span>Shopify
          </span>
          <span>
            <span className="dot"></span>Sellercloud
          </span>
          <a href="/health" style={{ fontSize: 12 }}>
            Health →
          </a>
        </div>
      </header>

      <Suspense fallback={<Loading />}>
        <Metrics />
      </Suspense>

      <div className="role-hdr">
        <div className="role-ic sup">S</div>
        <h2 className="role-ttl">Support team</h2>
        <span className="role-sub">Late fulfillments · VIP orders</span>
      </div>
      <Suspense fallback={<Loading />}>
        <LateFulfillments />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <VipOrders />
      </Suspense>

      <div className="role-hdr">
        <div className="role-ic sal">S</div>
        <h2 className="role-ttl">Sales team</h2>
        <span className="role-sub">Draft orders · abandoned carts</span>
      </div>
      <Suspense fallback={<Loading />}>
        <DraftsByRep />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <AbandonedCarts />
      </Suspense>
    </main>
  )
}

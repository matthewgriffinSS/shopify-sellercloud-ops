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
  await requireDashboardAuth()

  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

  return (
    <>
      <div className="header">
        <div className="brand">
          <span className="logo">OPS</span>
          <div className="divider"></div>
          <div>
            <div className="title">Ops Dashboard</div>
            <div className="meta">Shopify + Sellercloud · {today}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div className="status">
            <span>
              <span className="dot"></span>Shopify
            </span>
            <span>
              <span className="dot"></span>Sellercloud
            </span>
          </div>
          <a href="/health" className="icon-btn">
            Health
          </a>
        </div>
      </div>

      <main className="container">
        <Suspense fallback={<Loading />}>
          <Metrics />
        </Suspense>

        <div className="role-hdr">
          <div className="role-ic sup">S</div>
          <div className="role-ttl">Support team</div>
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
          <div className="role-ttl">Sales team</div>
          <span className="role-sub">Draft orders · abandoned carts</span>
        </div>
        <Suspense fallback={<Loading />}>
          <DraftsByRep />
        </Suspense>
        <Suspense fallback={<Loading />}>
          <AbandonedCarts />
        </Suspense>

        <div className="footer">OPS DASHBOARD · {today}</div>
      </main>
    </>
  )
}

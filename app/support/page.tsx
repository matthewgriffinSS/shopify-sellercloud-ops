import { Suspense } from 'react'
import Link from 'next/link'
import { requireDashboardAuth } from '@/lib/auth'
import { Metrics } from '@/app/components/Metrics'
import { LateFulfillments } from '@/app/components/LateFulfillments'
import { VipOrders } from '@/app/components/VipOrders'

export const dynamic = 'force-dynamic'
export const revalidate = 0

function Loading() {
  return <div className="empty">Loading…</div>
}

/**
 * Support team dashboard. Shows only what support reps need:
 * late fulfillments and VIP orders. Sales-specific sections
 * (drafts by rep, abandoned carts) live on /sales.
 */
export default async function SupportDashboardPage() {
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
            <div className="title">Support</div>
            <div className="meta">Late fulfillments · VIP orders · {today}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link href="/sales" className="icon-btn">
            Sales →
          </Link>
          <Link href="/" className="icon-btn">
            Home
          </Link>
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

        <div className="footer">OPS DASHBOARD · SUPPORT · {today}</div>
      </main>
    </>
  )
}

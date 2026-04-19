import { Suspense } from 'react'
import Link from 'next/link'
import { requireDashboardAuth } from '@/lib/auth'
import { Metrics } from '@/app/components/Metrics'
import { DraftsByRep } from '@/app/components/DraftsByRep'
import { AbandonedCarts } from '@/app/components/AbandonedCarts'

export const dynamic = 'force-dynamic'
export const revalidate = 0

function Loading() {
  return <div className="empty">Loading…</div>
}

/**
 * Sales team dashboard. Shows only what sales reps need:
 * draft order follow-ups (by rep) and high-value abandoned carts.
 * Support-specific sections live on /support.
 */
export default async function SalesDashboardPage() {
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
            <div className="title">Sales</div>
            <div className="meta">Draft follow-ups · Abandoned carts · {today}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link href="/support" className="icon-btn">
            Support →
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
          <div className="role-ic sal">S</div>
          <div className="role-ttl">Sales team</div>
          <span className="role-sub">
            Invoiced drafts (last 60 days) · abandoned carts
          </span>
        </div>
        <Suspense fallback={<Loading />}>
          <DraftsByRep />
        </Suspense>
        <Suspense fallback={<Loading />}>
          <AbandonedCarts />
        </Suspense>

        <div className="footer">OPS DASHBOARD · SALES · {today}</div>
      </main>
    </>
  )
}

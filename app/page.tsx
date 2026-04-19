import Link from 'next/link'
import { requireDashboardAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Landing page. Offers two clearly separated routes so support reps don't
 * see sales clutter and vice versa.
 */
export default async function HomePage() {
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
          <a href="/health" className="icon-btn">
            Health
          </a>
        </div>
      </div>

      <main className="container">
        <div className="landing">
          <Link href="/support" className="landing-card landing-sup">
            <div className="landing-ic">S</div>
            <div className="landing-ttl">Support</div>
            <div className="landing-sub">Late fulfillments · VIP orders</div>
          </Link>

          <Link href="/sales" className="landing-card landing-sal">
            <div className="landing-ic">S</div>
            <div className="landing-ttl">Sales</div>
            <div className="landing-sub">Draft follow-ups · abandoned carts</div>
          </Link>
        </div>

        <div className="footer">OPS DASHBOARD · {today}</div>
      </main>
    </>
  )
}

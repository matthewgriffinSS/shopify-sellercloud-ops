import { fetchMetrics } from '@/lib/queries'

function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)
}

export async function Metrics() {
  const m = await fetchMetrics()
  return (
    <div className="kpi-row">
      <div className="kpi">
        <div className="label">Revenue at risk</div>
        <div className="value">{formatMoney(m.revenueAtRisk)}</div>
        <div className="detail">Late + abandoned</div>
      </div>
      <div className="kpi">
        <div className="label">Awaiting action</div>
        <div className="value">{m.awaitingAction}</div>
        <div className="detail">Across all queues</div>
      </div>
      <div className="kpi">
        <div className="label">Processed today</div>
        <div className="value">{m.processedToday}</div>
        <div className="detail">Via dashboard</div>
      </div>
      <div className="kpi">
        <div className="label">Avg resolve</div>
        <div className="value">{m.avgResolveHours ? `${m.avgResolveHours.toFixed(1)}H` : '—'}</div>
        <div className="detail">Rolling 7 days</div>
      </div>
      <div className="kpi">
        <div className="label">VIP MTD</div>
        <div className="value">{formatMoney(m.vipRevenueMtd)}</div>
        <div className="detail">{m.vipOrderCountMtd} orders</div>
      </div>
    </div>
  )
}

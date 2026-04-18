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
    <div className="mgrid">
      <div className="m">
        <p className="m-lbl">Revenue at risk</p>
        <p className="m-v">{formatMoney(m.revenueAtRisk)}</p>
        <p className="m-d">Late orders + abandoned carts</p>
      </div>
      <div className="m">
        <p className="m-lbl">Awaiting action</p>
        <p className="m-v">{m.awaitingAction}</p>
        <p className="m-d">Across all queues</p>
      </div>
      <div className="m">
        <p className="m-lbl">Processed today</p>
        <p className="m-v">{m.processedToday}</p>
        <p className="m-d">Via dashboard actions</p>
      </div>
      <div className="m">
        <p className="m-lbl">Avg time to resolve</p>
        <p className="m-v">
          {m.avgResolveHours ? `${m.avgResolveHours.toFixed(1)}h` : '—'}
        </p>
        <p className="m-d">Rolling 7 days</p>
      </div>
      <div className="m">
        <p className="m-lbl">VIP revenue MTD</p>
        <p className="m-v">{formatMoney(m.vipRevenueMtd)}</p>
        <p className="m-d">{m.vipOrderCountMtd} orders</p>
      </div>
    </div>
  )
}

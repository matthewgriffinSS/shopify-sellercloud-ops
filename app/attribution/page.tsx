// app/attribution/page.tsx
//
// Open /attribution. Protected by your existing dashboard login
// (requireDashboardAuth -> /login when DASHBOARD_PASSWORD is set).
// Defaults to the previous calendar month; ?month=YYYY-MM picks another.

import { requireDashboardAuth } from '@/lib/auth'
import { buildReport, type AttrReport } from '@/lib/attribution'
import Attribution from './Attribution'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60 // a month of orders + calls; raise/lower per plan

export default async function AttributionPage({ searchParams }: any) {
  await requireDashboardAuth()

  const sp = (await searchParams) || {}
  const now = new Date()
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const defaultMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
  const month =
    typeof sp.month === 'string' && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : defaultMonth

  let report: AttrReport | null = null
  let error: string | null = null
  try {
    report = await buildReport(month)
  } catch (e: any) {
    error = e?.message || String(e)
  }

  return <Attribution report={report} error={error} month={month} />
}

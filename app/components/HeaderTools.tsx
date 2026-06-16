'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { timeAgo } from './shared'
import { getCurrentRep, setCurrentRep } from './rep'

/**
 * Header widget, mounted on every dashboard page:
 *
 *   ● Synced 23m ago   [↻ Sync now]   I am: [Caitlin ▾]
 *
 * 1. Freshness indicator. Since the webhook→cron cutover the data can be up
 *    to one interval stale; this makes that visible instead of invisible.
 *    Green dot = last sync OK and recent. Orange = OK but more than 3 hours
 *    ago (a scheduled run was missed — check the Actions tab, and remember
 *    GitHub disables schedules after 60 days without repo activity).
 *    Red = the last run failed.
 *
 * 2. Sync now. Hits /api/cron/sync with the dashboard cookie (the route
 *    already accepts that), then refreshes the page data. No more visiting
 *    the raw JSON URL.
 *
 * 3. Rep picker. Stores the rep's name in this browser via rep.ts; every
 *    action POST sends it as `actor`, and the cart email composer signs
 *    with it. Names come from draft assignments — zero configuration.
 */

type SyncStatus = {
  lastRun: {
    ranAt: string
    ok: boolean
    triggeredBy: string | null
    elapsedMs: number | null
    error: string | null
  } | null
  reps: string[]
}

const STALE_AFTER_MS = 3 * 60 * 60 * 1000 // 3 hours ≈ one missed 2h run

export function HeaderTools() {
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [rep, setRep] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/sync-status')
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'status unavailable')
      setStatus({ lastRun: data.lastRun, reps: data.reps })
      setStatusError(false)
    } catch {
      setStatusError(true)
    }
  }, [])

  // Mount: read the saved rep (localStorage isn't available during SSR,
  // which is why this whole widget waits for `mounted`) and fetch status.
  useEffect(() => {
    setMounted(true)
    setRep(getCurrentRep())
    loadStatus()
  }, [loadStatus])

  // Re-render once a minute so "23m ago" doesn't fossilize while the tab
  // sits open. No network involved — just recomputing the label.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  async function syncNow() {
    setSyncing(true)
    try {
      const res = await fetch('/api/cron/sync')
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'sync failed')
      await loadStatus()
      router.refresh() // re-pull the server components so tables update
    } catch (err) {
      window.alert(`Sync failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      await loadStatus() // the failed run is logged too — show it
    } finally {
      setSyncing(false)
    }
  }

  function changeRep(value: string) {
    const next = value === '' ? null : value
    setCurrentRep(next)
    setRep(next)
  }

  if (!mounted) return null

  // ---- Freshness pill ----
  let pill: React.ReactNode
  if (statusError) {
    pill = <span className="sync-pill">Sync status unavailable</span>
  } else if (!status) {
    pill = <span className="sync-pill">…</span>
  } else if (!status.lastRun) {
    pill = (
      <span className="sync-pill">
        <span className="dot dot-warn" />
        No syncs yet
      </span>
    )
  } else {
    const ranAt = new Date(status.lastRun.ranAt)
    const age = Date.now() - ranAt.getTime()
    const failed = !status.lastRun.ok
    const stale = age > STALE_AFTER_MS
    const dotClass = failed ? 'dot dot-bad' : stale ? 'dot dot-warn' : 'dot'
    const label = failed ? `Sync failed ${timeAgo(ranAt)}` : `Synced ${timeAgo(ranAt)}`
    pill = (
      <span
        className="sync-pill"
        title={
          failed
            ? status.lastRun.error ?? 'Last sync failed'
            : `Last run via ${status.lastRun.triggeredBy ?? '?'} in ${status.lastRun.elapsedMs ?? '?'}ms`
        }
      >
        <span className={dotClass} />
        {label}
      </span>
    )
  }

  return (
    <span className="header-tools">
      {pill}
      <button
        type="button"
        className="icon-btn"
        onClick={syncNow}
        disabled={syncing}
        title="Pull fresh orders + carts from Shopify right now"
      >
        {syncing ? 'Syncing…' : '↻ Sync now'}
      </button>
      {status && status.reps.length > 0 && (
        <select
          className="rep-select"
          value={rep ?? ''}
          onChange={(e) => changeRep(e.target.value)}
          title="Your actions and cart emails will carry this name"
        >
          <option value="">I am…</option>
          {status.reps.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      )}
    </span>
  )
}

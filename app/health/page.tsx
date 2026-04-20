'use client'

import { useCallback, useEffect, useState } from 'react'

type Check = { name: string; ok: boolean; latencyMs: number | null; detail: string }
type HealthResponse = { ok: boolean; checkedAt: string; checks: Check[] }
type JobResult = { ok: boolean; checked: number; upserted: number; triggeredBy: string } | null

const SERVICES: Record<
  string,
  { label: string; description: string; fix: string }
> = {
  database: {
    label: 'Postgres (Neon)',
    description: 'Stores orders, drafts, abandoned carts, and processing actions.',
    fix: 'If this fails: confirm DATABASE_URL is set in Vercel env vars and that db/schema.sql has been applied via the Neon SQL Editor.',
  },
  shopify: {
    label: 'Shopify Admin API',
    description: 'Powers webhooks and the late-fulfillment cron job.',
    fix: 'If this fails: double-check SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, and SHOPIFY_STORE_DOMAIN. The app must be a custom distribution app installed on the store.',
  },
  sellercloud: {
    label: 'Sellercloud REST API',
    description: 'Where order notes and shipments are posted when reps take action.',
    fix: 'If this fails: verify SELLERCLOUD_API_URL ends with /rest, and that the SC user has API access enabled.',
  },
}

/**
 * fetch + JSON-parse with actually-useful error messages.
 */
async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init })
  const text = await res.text()
  const contentType = res.headers.get('content-type') || ''

  if (!res.ok) {
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(text)
        throw new Error(parsed.error || `HTTP ${res.status} at ${url}`)
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('HTTP ')) throw e
      }
    }
    const snippet = text.trim().slice(0, 200) || '(empty body)'
    throw new Error(`HTTP ${res.status} at ${url} — ${snippet}`)
  }

  if (!text) throw new Error(`Empty response from ${url}`)

  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.trim().slice(0, 200)}`)
  }
}

export default function HealthPage() {
  const [data, setData] = useState<HealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null)
  const [jobRunning, setJobRunning] = useState(false)
  const [jobResult, setJobResult] = useState<JobResult>(null)
  const [jobError, setJobError] = useState<string | null>(null)

  const runLateFulfillmentJob = useCallback(async () => {
    setJobRunning(true)
    setJobResult(null)
    setJobError(null)
    try {
      setJobResult(await fetchJson('/api/cron/check-late-fulfillments'))
    } catch (err) {
      setJobError(err instanceof Error ? err.message : 'Failed to run')
    } finally {
      setJobRunning(false)
    }
  }, [])

  // --- Webhook registration state ---
  const [webhookStatus, setWebhookStatus] = useState<any>(null)
  const [webhookLoading, setWebhookLoading] = useState(false)
  const [webhookError, setWebhookError] = useState<string | null>(null)

  const checkWebhooks = useCallback(async () => {
    setWebhookLoading(true)
    setWebhookError(null)
    try {
      const data = await fetchJson('/api/admin/webhooks')
      if (!data.ok) setWebhookError(data.error || 'Failed')
      else setWebhookStatus(data)
    } catch (err) {
      setWebhookError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setWebhookLoading(false)
    }
  }, [])

  const registerWebhooks = useCallback(async () => {
    setWebhookLoading(true)
    setWebhookError(null)
    try {
      const data = await fetchJson('/api/admin/webhooks', { method: 'POST' })
      if (!data.ok) setWebhookError(data.error || 'Failed')
      await checkWebhooks() // refresh status
    } catch (err) {
      setWebhookError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setWebhookLoading(false)
    }
  }, [checkWebhooks])

  // --- Backfill drafts state ---
  const [backfillRunning, setBackfillRunning] = useState(false)
  const [backfillResult, setBackfillResult] = useState<any>(null)
  const [backfillError, setBackfillError] = useState<string | null>(null)

  const backfillDrafts = useCallback(async () => {
    setBackfillRunning(true)
    setBackfillResult(null)
    setBackfillError(null)
    try {
      const data = await fetchJson('/api/admin/backfill-drafts', { method: 'POST' })
      if (!data.ok) setBackfillError(data.error || 'Failed')
      else setBackfillResult(data)
    } catch (err) {
      setBackfillError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBackfillRunning(false)
    }
  }, [])

  // --- Backfill abandoned carts state ---
  const [cartsRunning, setCartsRunning] = useState(false)
  const [cartsResult, setCartsResult] = useState<any>(null)
  const [cartsError, setCartsError] = useState<string | null>(null)

  const backfillAbandonedCarts = useCallback(async () => {
    setCartsRunning(true)
    setCartsResult(null)
    setCartsError(null)
    try {
      const data = await fetchJson('/api/admin/backfill-abandoned-carts', { method: 'POST' })
      if (!data.ok) setCartsError(data.error || 'Failed')
      else setCartsResult(data)
    } catch (err) {
      setCartsError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setCartsRunning(false)
    }
  }, [])

  // --- Backfill customer names state ---
  const [namesRunning, setNamesRunning] = useState(false)
  const [namesResult, setNamesResult] = useState<any>(null)
  const [namesError, setNamesError] = useState<string | null>(null)

  const backfillCustomerNames = useCallback(async () => {
    setNamesRunning(true)
    setNamesResult(null)
    setNamesError(null)
    try {
      const data = await fetchJson('/api/admin/backfill-customer-names', { method: 'POST' })
      if (!data.ok) setNamesError(data.error || 'Failed')
      else setNamesResult(data)
    } catch (err) {
      setNamesError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setNamesRunning(false)
    }
  }, [])

  // --- Backfill Sellercloud IDs state ---
  const [scRunning, setScRunning] = useState(false)
  const [scResult, setScResult] = useState<any>(null)
  const [scError, setScError] = useState<string | null>(null)

  const backfillSellercloudIds = useCallback(async () => {
    setScRunning(true)
    setScResult(null)
    setScError(null)
    try {
      const data = await fetchJson('/api/admin/backfill-sc-ids', { method: 'POST' })
      if (!data.ok) setScError(data.error || 'Failed')
      else setScResult(data)
    } catch (err) {
      setScError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setScRunning(false)
    }
  }, [])

  const check = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/health', { cache: 'no-store' })
      if (res.status === 401) {
        setError('Not authenticated. Sign in to the dashboard first.')
        setData(null)
        return
      }
      const text = await res.text()
      try {
        setData(JSON.parse(text) as HealthResponse)
        setLastCheckedAt(new Date())
      } catch {
        setError(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run health check')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    check()
  }, [check])

  const allOk = data?.ok ?? false

  return (
    <main className="container" style={{ maxWidth: 820 }}>
      <header className="hdr">
        <div>
          <h1 className="ttl">System health</h1>
          <p className="sub">
            Pings each service and reports latency. Run this after deploy or whenever something
            seems off.
          </p>
        </div>
        <div className="status-row">
          <a href="/" style={{ fontSize: 13 }}>
            ← Back to dashboard
          </a>
        </div>
      </header>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '14px 16px',
          background: allOk
            ? 'var(--success-bg)'
            : data
              ? 'var(--danger-bg)'
              : 'var(--surface-2)',
          color: allOk
            ? 'var(--success-text)'
            : data
              ? 'var(--danger-text)'
              : 'var(--text-2)',
          borderRadius: 'var(--radius-md)',
          marginBottom: 20,
          fontSize: 14,
          fontWeight: 500,
        }}
      >
        <span>
          {loading
            ? 'Checking…'
            : error
              ? error
              : allOk
                ? '✓ All systems operational'
                : '✗ One or more services failed'}
        </span>
        <button
          onClick={check}
          disabled={loading}
          className="btn-sm"
          style={{ minWidth: 80 }}
        >
          {loading ? 'Checking…' : 'Run again'}
        </button>
      </div>

      {data && (
        <div style={{ display: 'grid', gap: 10 }}>
          {data.checks.map((c) => {
            const meta = SERVICES[c.name] ?? { label: c.name, description: '', fix: '' }
            return (
              <div
                key={c.name}
                style={{
                  background: 'var(--surface)',
                  border: '0.5px solid var(--border)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '14px 16px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 12,
                    marginBottom: 6,
                  }}
                >
                  <h2 style={{ fontSize: 15, fontWeight: 500, margin: 0 }}>{meta.label}</h2>
                  <span className={c.ok ? 'bdg b-s' : 'bdg b-d'} style={{ flexShrink: 0 }}>
                    {c.ok ? '✓ ok' : '✗ failed'}
                    {c.latencyMs !== null && ` · ${c.latencyMs}ms`}
                  </span>
                </div>
                {meta.description && (
                  <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '0 0 8px' }}>
                    {meta.description}
                  </p>
                )}
                <div
                  style={{
                    fontSize: 12,
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--surface-2)',
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-md)',
                    color: c.ok ? 'var(--text-2)' : 'var(--danger-text)',
                    wordBreak: 'break-word',
                  }}
                >
                  {c.detail}
                </div>
                {!c.ok && meta.fix && (
                  <p
                    style={{
                      fontSize: 12,
                      color: 'var(--text-2)',
                      margin: '8px 0 0',
                      fontStyle: 'italic',
                    }}
                  >
                    {meta.fix}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      {lastCheckedAt && (
        <p
          style={{
            fontSize: 12,
            color: 'var(--text-3)',
            marginTop: 20,
            textAlign: 'center',
          }}
        >
          Last checked {lastCheckedAt.toLocaleTimeString()}
        </p>
      )}

      <section style={{ marginTop: 40 }}>
        <h2 style={{ fontSize: 16, fontWeight: 500, margin: '0 0 10px' }}>Scheduled jobs</h2>
        <div
          style={{
            background: 'var(--surface)',
            border: '0.5px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            padding: '14px 16px',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: 12,
              marginBottom: 6,
            }}
          >
            <h3 style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>Late fulfillment scan</h3>
            <span className="bdg b-n">Daily at 07:00 UTC</span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '0 0 12px' }}>
            Scans Shopify for orders unfulfilled ≥ 3 days and adds them to the dashboard's Late
            Fulfillments section. Runs automatically once per day; trigger manually here if you
            need a fresher view.
          </p>
          <button
            className="btn-sm"
            onClick={runLateFulfillmentJob}
            disabled={jobRunning}
            style={{ marginBottom: jobResult || jobError ? 10 : 0 }}
          >
            {jobRunning ? 'Running…' : 'Run now'}
          </button>
          {jobResult && (
            <div
              style={{
                fontSize: 12,
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--success-bg)',
                color: 'var(--success-text)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              Scanned {jobResult.checked} orders, updated {jobResult.upserted} in the dashboard.
            </div>
          )}
          {jobError && (
            <div
              style={{
                fontSize: 12,
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--danger-bg)',
                color: 'var(--danger-text)',
                fontFamily: 'var(--font-mono)',
                wordBreak: 'break-word',
              }}
            >
              {jobError}
            </div>
          )}
        </div>
      </section>

      {/* ---------- Webhook registration ---------- */}
      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 500, margin: '0 0 10px' }}>Shopify webhooks</h2>
        <div className="card" style={{ marginBottom: 0 }}>
          <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '0 0 12px' }}>
            Webhooks must be registered before Shopify will send draft order and abandoned cart
            events. Check which are currently registered, and click Register to auto-create any
            that are missing.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-sm" onClick={checkWebhooks} disabled={webhookLoading}>
              {webhookLoading ? 'Checking…' : 'Check status'}
            </button>
            <button
              className="btn-sm btn-primary"
              onClick={registerWebhooks}
              disabled={webhookLoading}
            >
              {webhookLoading ? 'Working…' : 'Register missing webhooks'}
            </button>
          </div>
          {webhookError && (
            <div
              style={{
                fontSize: 12,
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--danger-bg)',
                color: 'var(--danger-text)',
                fontFamily: 'var(--font-mono)',
                marginTop: 10,
                wordBreak: 'break-word',
              }}
            >
              {webhookError}
            </div>
          )}
          {webhookStatus && (
            <div style={{ marginTop: 12 }}>
              <table style={{ width: '100%', fontSize: 11 }}>
                <thead>
                  <tr>
                    <th>Topic</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {webhookStatus.required.map((w: any) => (
                    <tr key={w.topic}>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{w.topic}</td>
                      <td>
                        {w.registered ? (
                          <span className="bdg b-s">Registered</span>
                        ) : w.wrongAddress ? (
                          <span className="bdg b-w">Wrong URL</span>
                        ) : (
                          <span className="bdg b-d">Missing</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* ---------- Backfill data ---------- */}
      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 500, margin: '0 0 10px' }}>Backfill data</h2>

        {/* Drafts */}
        <div className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 500, margin: '0 0 6px' }}>
            Draft orders from Shopify
          </h3>
          <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '0 0 12px' }}>
            Webhooks only fire for new events. Use this to pull all currently-open drafts from
            Shopify so they show on the dashboard immediately without waiting for the next update.
          </p>
          <button className="btn-sm" onClick={backfillDrafts} disabled={backfillRunning}>
            {backfillRunning ? 'Running…' : 'Backfill open drafts from Shopify'}
          </button>
          {backfillResult && (
            <div
              style={{
                fontSize: 12,
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--success-bg)',
                color: 'var(--success-text)',
                fontFamily: 'var(--font-mono)',
                marginTop: 10,
              }}
            >
              Fetched {backfillResult.fetched}, upserted {backfillResult.upserted}.
              {backfillResult.unassignedAfterBackfill > 0 &&
                ` ${backfillResult.unassignedAfterBackfill} unassigned (rep tag missing).`}
            </div>
          )}
          {backfillError && (
            <div
              style={{
                fontSize: 12,
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--danger-bg)',
                color: 'var(--danger-text)',
                fontFamily: 'var(--font-mono)',
                marginTop: 10,
                wordBreak: 'break-word',
              }}
            >
              {backfillError}
            </div>
          )}
        </div>

        {/* Abandoned carts */}
        <div className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 500, margin: '0 0 6px' }}>
            High-value abandoned carts from Shopify
          </h3>
          <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '0 0 12px' }}>
            Pulls abandoned checkouts from the last 7 days and stores any that are $2000+.
            Use this after fixing a webhook issue or on first deploy to retroactively populate
            carts that Shopify has but we don't. Safe to re-run — only inserts or refreshes
            existing rows.
          </p>
          <button className="btn-sm" onClick={backfillAbandonedCarts} disabled={cartsRunning}>
            {cartsRunning ? 'Running…' : 'Backfill abandoned carts from Shopify'}
          </button>
          {cartsResult && (
            <div
              style={{
                fontSize: 12,
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--success-bg)',
                color: 'var(--success-text)',
                fontFamily: 'var(--font-mono)',
                marginTop: 10,
              }}
            >
              Fetched {cartsResult.fetched} carts, upserted {cartsResult.upserted} high-value.
              {cartsResult.skippedLowValue > 0 &&
                ` Skipped ${cartsResult.skippedLowValue} below $2000.`}
              {typeof cartsResult.visibleOnDashboard === 'number' &&
                ` ${cartsResult.visibleOnDashboard} now visible on /sales.`}
            </div>
          )}
          {cartsError && (
            <div
              style={{
                fontSize: 12,
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--danger-bg)',
                color: 'var(--danger-text)',
                fontFamily: 'var(--font-mono)',
                marginTop: 10,
                wordBreak: 'break-word',
              }}
            >
              {cartsError}
            </div>
          )}
        </div>

        {/* Customer names */}
        <div className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 500, margin: '0 0 6px' }}>
            Customer names on orders
          </h3>
          <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '0 0 12px' }}>
            Fills in missing customer names on existing orders by pulling them from the raw
            Shopify payload we already stored. Use this if the Late Fulfillments or VIP Orders
            tables are showing "—" in the Customer column. Only rewrites rows where the name is
            currently NULL — won't overwrite anything good.
          </p>
          <button className="btn-sm" onClick={backfillCustomerNames} disabled={namesRunning}>
            {namesRunning ? 'Running…' : 'Backfill customer names'}
          </button>
          {namesResult && (
            <div
              style={{
                fontSize: 12,
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--success-bg)',
                color: 'var(--success-text)',
                fontFamily: 'var(--font-mono)',
                marginTop: 10,
              }}
            >
              Updated {namesResult.namesUpdated} names
              {namesResult.emailsUpdated ? `, ${namesResult.emailsUpdated} emails` : ''}.{' '}
              {namesResult.lateMissingBefore - namesResult.lateMissingAfter} late-fulfillment rows
              now show a customer name ({namesResult.lateMissingAfter} still missing).
            </div>
          )}
          {namesError && (
            <div
              style={{
                fontSize: 12,
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--danger-bg)',
                color: 'var(--danger-text)',
                fontFamily: 'var(--font-mono)',
                marginTop: 10,
                wordBreak: 'break-word',
              }}
            >
              {namesError}
            </div>
          )}
        </div>

        {/* Sellercloud IDs */}
        <div className="card" style={{ marginBottom: 0 }}>
          <h3 style={{ fontSize: 14, fontWeight: 500, margin: '0 0 6px' }}>
            Sellercloud order IDs
          </h3>
          <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '0 0 12px' }}>
            Looks up the Sellercloud order ID for each late-fulfillment and VIP order that doesn't
            have one yet, and stores it so the dashboard can link directly to the SC order detail
            page. Processes up to 100 orders per run — if "remaining" is non-zero, just click again.
          </p>
          <button className="btn-sm" onClick={backfillSellercloudIds} disabled={scRunning}>
            {scRunning ? 'Running…' : 'Backfill Sellercloud IDs'}
          </button>
          {scResult && (
            <div
              style={{
                fontSize: 12,
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: scResult.errors > 0 ? 'var(--danger-bg)' : 'var(--success-bg)',
                color:
                  scResult.errors > 0 ? 'var(--danger-text)' : 'var(--success-text)',
                fontFamily: 'var(--font-mono)',
                marginTop: 10,
              }}
            >
              Checked {scResult.checked}: found {scResult.found}, not found {scResult.notFound},
              errors {scResult.errors}. {scResult.remaining} remaining.
              {scResult.errorDetails && scResult.errorDetails.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 11, opacity: 0.85 }}>
                  First errors:
                  {scResult.errorDetails.slice(0, 3).map((e: any, i: number) => (
                    <div key={i}>
                      • #{e.orderNumber}: {e.error}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {scError && (
            <div
              style={{
                fontSize: 12,
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--danger-bg)',
                color: 'var(--danger-text)',
                fontFamily: 'var(--font-mono)',
                marginTop: 10,
                wordBreak: 'break-word',
              }}
            >
              {scError}
            </div>
          )}
        </div>
      </section>
    </main>
  )
}

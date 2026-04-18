'use client'

import { useCallback, useEffect, useState } from 'react'

type Check = { name: string; ok: boolean; latencyMs: number | null; detail: string }
type HealthResponse = { ok: boolean; checkedAt: string; checks: Check[] }

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

export default function HealthPage() {
  const [data, setData] = useState<HealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null)

  const check = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/health', { cache: 'no-store' })
      if (res.status === 401) {
        setError('Not authenticated. Sign in to the dashboard first.')
        setData(null)
        setLoading(false)
        return
      }
      const json = (await res.json()) as HealthResponse
      setData(json)
      setLastCheckedAt(new Date())
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
            const meta = SERVICES[c.name] ?? {
              label: c.name,
              description: '',
              fix: '',
            }
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
                  <span
                    className={c.ok ? 'bdg b-s' : 'bdg b-d'}
                    style={{ flexShrink: 0 }}
                  >
                    {c.ok ? '✓ ok' : '✗ failed'}
                    {c.latencyMs !== null && ` · ${c.latencyMs}ms`}
                  </span>
                </div>
                {meta.description && (
                  <p
                    style={{
                      fontSize: 13,
                      color: 'var(--text-2)',
                      margin: '0 0 8px',
                    }}
                  >
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
    </main>
  )
}

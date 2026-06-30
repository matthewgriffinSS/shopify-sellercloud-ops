'use client'
// app/attribution/Attribution.tsx
//
// Styled with the dashboard's existing tokens/classes (kpi-row, dfu-tbl, bdg,
// tag-p, btn, etc.). Phone matches + tag flags come pre-computed from the
// server; email matches are added in-browser when you load a Zendesk CSV.

import { useMemo, useRef, useState } from 'react'
import type { AttrReport, AttrOrder } from '@/lib/attribution'

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g
const EXCLUDE_DOMAINS = ['shocksurplus.com'] // internal addresses ignored as contacts

function extractEmails(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.match(EMAIL_RE) || []) {
    const e = m.trim().toLowerCase()
    const dom = e.split('@')[1] || ''
    if (EXCLUDE_DOMAINS.some((x) => dom === x || dom.endsWith('.' + x))) continue
    out.add(e)
  }
  return out
}
function money(v: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(v || 0)
}
function fmtDate(s: string): string {
  const t = Date.parse(s)
  return t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'
}
function fmtPhone(p: string): string {
  return `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`
}
function csvCell(v: unknown): string {
  const s = String(v ?? '')
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

type Computed = AttrOrder & {
  matchedEmail: string | null
  matchChannels: string[]
  associated: boolean
  channelMismatch: boolean
  category: 'credited' | 'uncredited' | 'taggedonly' | 'none'
}

export default function Attribution({
  report,
  error,
  month,
}: {
  report: AttrReport | null
  error: string | null
  month: string
}) {
  const [zEmails, setZEmails] = useState<Set<string>>(new Set())
  const [zName, setZName] = useState('')
  const [filter, setFilter] = useState<string>('uncredited')
  const [q, setQ] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const base = report?.orders ?? []

  const orders: Computed[] = useMemo(
    () =>
      base.map((o) => {
        const matchedEmail = o.emails.find((e) => zEmails.has(e)) || null
        const matchChannels = [o.matchedPhone ? 'phone' : '', matchedEmail ? 'email' : ''].filter(Boolean)
        const associated = !!(o.matchedPhone || matchedEmail)
        const verifiable = o.taggedChannels.filter((c) => c === 'phone' || c === 'email')
        const channelMismatch =
          associated && o.yourTag && verifiable.length > 0 && !verifiable.some((c) => matchChannels.includes(c))
        const category: Computed['category'] = associated
          ? o.yourTag
            ? 'credited'
            : 'uncredited'
          : o.yourTag
            ? 'taggedonly'
            : 'none'
        return { ...o, matchedEmail, matchChannels, associated, channelMismatch, category }
      }),
    [base, zEmails],
  )

  const counts = useMemo(
    () => ({
      all: orders.length,
      associated: orders.filter((o) => o.associated).length,
      uncredited: orders.filter((o) => o.category === 'uncredited').length,
      credited: orders.filter((o) => o.category === 'credited').length,
      taggedonly: orders.filter((o) => o.category === 'taggedonly').length,
      mismatch: orders.filter((o) => o.channelMismatch).length,
    }),
    [orders],
  )
  const sumOf = (pred: (o: Computed) => boolean) =>
    orders.filter(pred).reduce((s, o) => s + (o.total || 0), 0)

  const rows = useMemo(() => {
    let list = orders
    if (filter === 'associated') list = list.filter((o) => o.associated)
    else if (filter === 'uncredited') list = list.filter((o) => o.category === 'uncredited')
    else if (filter === 'credited') list = list.filter((o) => o.category === 'credited')
    else if (filter === 'taggedonly') list = list.filter((o) => o.category === 'taggedonly')
    else if (filter === 'mismatch') list = list.filter((o) => o.channelMismatch)
    if (q.trim()) {
      const s = q.toLowerCase()
      list = list.filter((o) =>
        [o.name, o.customer, o.tags, o.matchedEmail || '', o.matchedPhone || '', o.financial]
          .join(' ')
          .toLowerCase()
          .includes(s),
      )
    }
    return [...list].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
  }, [orders, filter, q])

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    const text = await f.text()
    setZEmails(extractEmails(text))
    setZName(f.name)
  }

  function exportCSV() {
    const head = [
      'Order', 'Date', 'Customer', 'Total', 'Financial', 'Fulfillment',
      'Matched email', 'Matched phone', 'Channels', 'Credited', 'Tagged channels', 'Wrong channel', 'Tags',
    ]
    const data = [
      head,
      ...rows.map((o) => [
        o.name, (o.createdAt || '').slice(0, 10), o.customer, o.total.toFixed(2), o.financial, o.fulfillment,
        o.matchedEmail || '', o.matchedPhone ? fmtPhone(o.matchedPhone) : '', o.matchChannels.join('+'),
        o.yourTag ? 'yes' : 'no', o.taggedChannels.join('+'), o.channelMismatch ? 'yes' : '', o.tags,
      ]),
    ]
    const csv = data.map((r) => r.map(csvCell).join(',')).join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `attribution-${month}-${filter}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1500)
  }

  const monthOpts = useMemo(() => {
    const opts: { v: string; label: string }[] = []
    const now = new Date()
    for (let i = 1; i <= 13; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      opts.push({
        v: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
        label: d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      })
    }
    if (!opts.some((o) => o.v === month)) {
      const [y, m] = month.split('-').map(Number)
      const d = new Date(Date.UTC(y, m - 1, 1))
      opts.unshift({ v: month, label: d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) })
    }
    return opts
  }, [month])
  const monthLabel = monthOpts.find((o) => o.v === month)?.label || month

  const TABS: Array<[string, string, number]> = [
    ['uncredited', 'Uncredited', counts.uncredited],
    ['associated', 'Associated', counts.associated],
    ['credited', 'Credited', counts.credited],
    ['taggedonly', 'Tagged · no match', counts.taggedonly],
    ['mismatch', 'Wrong channel', counts.mismatch],
    ['all', 'All', counts.all],
  ]

  return (
    <>
      <style>{SCOPED}</style>

      <div className="header">
        <div className="brand">
          <span className="logo">OPS</span>
          <div className="divider" />
          <div>
            <div className="title">Attribution</div>
            <div className="meta">
              My sales · {monthLabel}
              {report ? ` · ${report.phoneContacts} call contacts` : ''}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <select
            className="attr-month"
            value={month}
            onChange={(e) => window.location.assign('/attribution?month=' + e.target.value)}
          >
            {monthOpts.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </select>
          <a href="/sales" className="icon-btn">
            Sales →
          </a>
          <a href="/" className="icon-btn">
            Home
          </a>
        </div>
      </div>

      <main className="container">
        {error && <div className="attr-err">Couldn’t pull data: {error}</div>}

        {report && (
          <>
            <div className="kpi-row">
              <div className="kpi">
                <div className="label">Orders</div>
                <div className="value">{orders.length}</div>
                <div className="detail">{monthLabel}</div>
              </div>
              <div className="kpi">
                <div className="label">Associated</div>
                <div className="value">{counts.associated}</div>
                <div className="detail">{money(sumOf((o) => o.associated))} touched</div>
              </div>
              <div className="kpi attr-flag">
                <div className="label">Uncredited</div>
                <div className="value">{counts.uncredited}</div>
                <div className="detail">{money(sumOf((o) => o.category === 'uncredited'))} at stake</div>
              </div>
              <div className="kpi kpi-win">
                <div className="label">Credited</div>
                <div className="value">{counts.credited}</div>
                <div className="detail">{money(sumOf((o) => o.category === 'credited'))}</div>
              </div>
              <div className="kpi">
                <div className="label">Wrong channel</div>
                <div className="value">{counts.mismatch}</div>
                <div className="detail">tag vs match</div>
              </div>
            </div>

            <div className="attr-zone">
              <div>
                <strong>Zendesk emails:</strong>{' '}
                {zEmails.size > 0 ? (
                  <span className="attr-ok">{zEmails.size} loaded from {zName}</span>
                ) : (
                  <span className="attr-muted">
                    not loaded — phone matches only. Upload this month’s Zendesk CSV to add email matches.
                  </span>
                )}
              </div>
              <label className="btn btn-sm">
                {zEmails.size > 0 ? 'Replace CSV' : 'Load Zendesk CSV'}
                <input ref={fileRef} type="file" accept=".csv,.txt,.tsv" onChange={onFile} style={{ display: 'none' }} />
              </label>
            </div>

            {report.warnings.length > 0 && <div className="attr-warn">{report.warnings.join(' · ')}</div>}

            <div className="role-hdr">
              <div className="role-ic sal">A</div>
              <div className="role-ttl">{monthLabel}</div>
              <span className="role-sub">orders you reached, and whether they’re tagged to you</span>
            </div>

            <div className="attr-tabs">
              {TABS.map(([id, label, n]) => (
                <button
                  key={id}
                  className={'dfu-tab' + (filter === id ? ' dfu-tab-on' : '')}
                  onClick={() => setFilter(id)}
                >
                  {label}
                  <span className="dfu-tab-ct">{n}</span>
                </button>
              ))}
              <div style={{ flex: 1 }} />
              <input
                className="attr-search"
                placeholder="search…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <button className="btn btn-sm" onClick={exportCSV}>
                Export CSV
              </button>
            </div>

            <div className="dfu-wrap">
              <table className="dfu-tbl attr-tbl">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Date</th>
                    <th>Customer</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Matched</th>
                    <th>Credit</th>
                    <th>Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={8}>
                        <div className="empty" style={{ padding: 24 }}>
                          Nothing in this view.
                        </div>
                      </td>
                    </tr>
                  )}
                  {rows.map((o) => (
                    <tr key={o.id} className={o.category === 'uncredited' ? 'attr-r-unc' : undefined}>
                      <td className="dfu-inv">{o.name}</td>
                      <td>{fmtDate(o.createdAt)}</td>
                      <td>{o.customer}</td>
                      <td className="num">{money(o.total)}</td>
                      <td style={{ color: 'var(--text2)', fontSize: 11 }}>
                        {o.financial || '—'}
                        {o.fulfillment && o.fulfillment !== 'unfulfilled' ? ' · ' + o.fulfillment : ''}
                      </td>
                      <td>
                        <span
                          className={'attr-ch' + (o.matchedPhone ? ' on' : '')}
                          title={o.matchedPhone ? 'phone ' + fmtPhone(o.matchedPhone) : 'no phone match'}
                        >
                          ☎
                        </span>{' '}
                        <span
                          className={'attr-ch' + (o.matchedEmail ? ' on' : '')}
                          title={o.matchedEmail ? 'email ' + o.matchedEmail : 'no email match'}
                        >
                          ✉
                        </span>
                      </td>
                      <td>
                        {o.yourTag ? (
                          <span className="bdg b-s">✓ {o.taggedChannels.join('/') || 'you'}</span>
                        ) : o.associated ? (
                          <span className="bdg b-w">untagged</span>
                        ) : (
                          <span className="bdg b-n">—</span>
                        )}
                        {o.channelMismatch && (
                          <span className="bdg b-w" style={{ marginLeft: 6 }}>
                            ⚠ {o.matchChannels.join('/')}
                          </span>
                        )}
                      </td>
                      <td>
                        {o.tags ? (
                          o.tags.split(',').map((t, i) => (
                            <span key={i} className="tag-p">
                              {t.trim()}
                            </span>
                          ))
                        ) : (
                          <span style={{ color: 'var(--text3)', fontSize: 11 }}>none</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="footer">
              OPS DASHBOARD · ATTRIBUTION · {monthLabel} · pulled{' '}
              {new Date(report.generatedAt).toLocaleString()}
            </div>
          </>
        )}
      </main>
    </>
  )
}

const SCOPED = `
.attr-month{background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;font-family:var(--font-body);cursor:pointer}
.attr-err{background:var(--danger-bg);color:var(--danger-text);border:1px solid rgba(255,69,58,.3);border-radius:8px;padding:14px;margin-bottom:16px;font-size:13px}
.attr-warn{background:var(--warn-bg);color:var(--warn-text);border:1px solid rgba(255,214,10,.3);border-radius:8px;padding:9px 12px;margin:10px 0;font-size:12px}
.attr-zone{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:14px 0;font-size:12px;color:var(--text)}
.attr-ok{color:var(--green)}
.attr-muted{color:var(--text2)}
.kpi.attr-flag{border-color:rgba(232,93,36,.4)}
.kpi.attr-flag .value{color:var(--accent)}
.attr-tabs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--border);margin-top:8px}
.attr-search{background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;width:150px;font-family:var(--font-mono)}
.attr-ch{color:var(--text3)}
.attr-ch.on{color:var(--accent)}
.dfu-tbl.attr-tbl th{width:auto!important}
.attr-tbl .num{font-family:var(--font-mono);text-align:right}
.attr-tbl tbody tr.attr-r-unc td{background:rgba(232,93,36,.06)}
`

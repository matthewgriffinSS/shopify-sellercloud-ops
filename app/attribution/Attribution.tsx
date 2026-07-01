'use client'
// app/attribution/Attribution.tsx
//
// Phone matches + tag flags come from the server. The Zendesk link comes from a
// CSV you load in-browser: the customer email/name fields in Zendesk are empty,
// but the ORDER NUMBER is in the ticket Subject ("...Order SS312302..."). So we
// extract order numbers from the subject and match them to Shopify order names
// (this needs no customer PII, so Shopify Protected Customer Data can't block it).
// Rows are filtered to the selected month (via the date column) and, optionally,
// to tickets whose assignee matches your name.

import { useMemo, useState } from 'react'
import type { AttrReport, AttrOrder } from '@/lib/attribution'

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g
const EMAIL_ONE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/
const ORDER_TOKEN = /[A-Za-z]{0,4}\d{4,}/g
const EXCLUDE_DOMAINS = ['shocksurplus.com']
// Base for opening a ticket in Zendesk to verify the interaction.
const ZENDESK_TICKET_URL = 'https://apghelpdesk.zendesk.com/agent/tickets/'

const normId = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

function collectInto(set: Set<string>, cell: string) {
  for (const m of (cell || '').toLowerCase().match(EMAIL_RE) || []) {
    const dom = m.split('@')[1] || ''
    if (!EXCLUDE_DOMAINS.some((x) => dom === x || dom.endsWith('.' + x))) set.add(m)
  }
}

// ---------- CSV ----------
function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  let inQ = false
  while (i < text.length) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQ = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"') { inQ = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += c; i++
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}
function findCol(headers: string[], includes: string, exclude?: RegExp): number {
  const H = headers.map((h) => h.toLowerCase())
  return H.findIndex((h) => h.includes(includes) && (!exclude || !exclude.test(h)))
}
function detectDateCol(headers: string[], rows: string[][]): number {
  const H = headers.map((h) => h.toLowerCase())
  for (const key of ['requested', 'created at', 'created', 'create date', 'date', 'updated']) {
    const idx = H.findIndex((h) => h.includes(key))
    if (idx >= 0) {
      let ok = 0
      for (const r of rows.slice(0, 60)) { const v = (r[idx] || '').trim(); if (/\d/.test(v) && !isNaN(Date.parse(v))) ok++ }
      if (ok >= 3) return idx
    }
  }
  return -1
}

// ---------- formatting ----------
function money(v: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v || 0)
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
  ticketId: string | null
  ticketSubject: string | null
  matchChannels: string[]
  associated: boolean
  channelMismatch: boolean
  category: 'credited' | 'uncredited' | 'taggedonly' | 'none'
}
type Col = { name: string; filled: number; total: number; sample: string; isEmail: boolean }
type ZState = {
  name?: string
  keptRows?: string[][]
  emailIdx?: number
  dateIdx?: number
  assigneeIdx?: number
  subjectIdx?: number
  ticketIdx?: number
  dateCol?: string
  assigneeCol?: string
  subjectCol?: string
  ticketCol?: string
  emailCol?: string
  monthKept?: number
  totalRows?: number
  monthFiltered?: boolean
  columns?: Col[]
  error?: string
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
  const [z, setZ] = useState<ZState>({})
  const [assignee, setAssignee] = useState(report?.lastname ?? '')
  const [filter, setFilter] = useState<string>('uncredited')
  const [q, setQ] = useState('')

  const base = report?.orders ?? []

  // From the loaded tickets (already month-filtered), narrowed live by assignee:
  // the set of customer emails, and — per email — which ticket(s) they came from,
  // so a matched order can link straight to a ticket for verification.
  const zDerived = useMemo(() => {
    const emails = new Set<string>()
    const emailTickets = new Map<string, { id: string; subject: string }[]>()
    let ticketsUsed = 0
    if (z.keptRows) {
      const aIdx = z.assigneeIdx ?? -1
      const eIdx = z.emailIdx ?? -1
      const sIdx = z.subjectIdx ?? -1
      const tIdx = z.ticketIdx ?? -1
      const term = assignee.trim().toLowerCase()
      for (const r of z.keptRows) {
        if (term && aIdx >= 0 && !(r[aIdx] || '').toLowerCase().includes(term)) continue
        ticketsUsed++
        const id = tIdx >= 0 ? (r[tIdx] || '').trim() : ''
        const subject = sIdx >= 0 ? r[sIdx] || '' : ''
        const found = new Set<string>()
        collectInto(found, eIdx >= 0 ? r[eIdx] || '' : r.join(' '))
        for (const e of found) {
          emails.add(e)
          if (id) {
            const arr = emailTickets.get(e) || []
            arr.push({ id, subject })
            emailTickets.set(e, arr)
          }
        }
      }
    }
    return { emails, emailTickets, ticketsUsed }
  }, [z, assignee])

  const orders: Computed[] = useMemo(
    () =>
      base.map((o) => {
        const matchedEmail = o.emails.find((e) => zDerived.emails.has(e)) || null
        // Among this customer's tickets, prefer the one whose subject names this
        // order number; otherwise link the first. Subject is only used to pick
        // WHICH ticket to open — the match itself is purely by email.
        let ticketId: string | null = null
        let ticketSubject: string | null = null
        if (matchedEmail) {
          const list = zDerived.emailTickets.get(matchedEmail) || []
          if (list.length) {
            const nName = normId(o.name)
            const digits = nName.replace(/[^0-9]/g, '')
            const best =
              list.find((t) =>
                ((t.subject || '').toUpperCase().match(ORDER_TOKEN) || []).some((tok) => {
                  const nn = normId(tok)
                  return nn === nName || (digits.length >= 5 && nn.replace(/[^0-9]/g, '') === digits)
                }),
              ) || list[0]
            ticketId = best.id || null
            ticketSubject = best.subject || null
          }
        }
        const support = !!matchedEmail
        const matchChannels = [o.matchedPhone ? 'phone' : '', support ? 'email' : ''].filter(Boolean)
        const associated = !!(o.matchedPhone || support)
        const verifiable = o.taggedChannels.filter((c) => c === 'phone' || c === 'email')
        const channelMismatch =
          associated && o.yourTag && verifiable.length > 0 && !verifiable.some((c) => matchChannels.includes(c))
        const category: Computed['category'] = associated
          ? o.yourTag ? 'credited' : 'uncredited'
          : o.yourTag ? 'taggedonly' : 'none'
        return { ...o, matchedEmail, ticketId, ticketSubject, matchChannels, associated, channelMismatch, category }
      }),
    [base, zDerived],
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
  const sumOf = (pred: (o: Computed) => boolean) => orders.filter(pred).reduce((s, o) => s + (o.total || 0), 0)

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
          .join(' ').toLowerCase().includes(s),
      )
    }
    return [...list].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
  }, [orders, filter, q])

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    try {
      const text = await f.text()
      const parsed = parseCSV(text)
      if (parsed.length < 2) {
        setZ({ name: f.name, error: 'That CSV looks empty.' })
        return
      }
      const headers = parsed[0].map((h) => h.trim())
      const dataRows = parsed.slice(1)
      const subjectIdx = findCol(headers, 'subject')
      const assigneeIdx = findCol(headers, 'assignee', /id/)
      const emailIdx = findCol(headers, 'mail', /(assignee|agent|submitter)/)
      const dateIdx = detectDateCol(headers, dataRows)
      const ticketIdx = (() => {
        const i = findCol(headers, 'ticket')
        if (i >= 0) return i
        return headers.findIndex((h) => h.trim().toLowerCase() === 'id')
      })()

      const [my, mm] = month.split('-').map(Number)
      const start = Date.UTC(my, mm - 1, 1)
      const end = Date.UTC(my, mm, 1)

      let keptRows = dataRows
      const monthFiltered = dateIdx >= 0
      if (monthFiltered) {
        keptRows = dataRows.filter((r) => {
          const t = Date.parse((r[dateIdx] || '').trim())
          return !isNaN(t) && t >= start && t < end
        })
      }

      const columns: Col[] = headers.map((h, c) => {
        let filled = 0
        let sample = ''
        for (const r of dataRows) { const v = (r[c] || '').trim(); if (v && v !== "'-" && v !== '-') { filled++; if (!sample) sample = v } }
        let emailHits = 0
        for (const r of dataRows.slice(0, 300)) if (EMAIL_ONE.test(r[c] || '')) emailHits++
        return { name: h, filled, total: dataRows.length, sample: sample.slice(0, 48), isEmail: emailHits >= 3 }
      })

      setZ({
        name: f.name,
        keptRows,
        emailIdx,
        dateIdx,
        assigneeIdx,
        subjectIdx,
        ticketIdx,
        dateCol: dateIdx >= 0 ? headers[dateIdx] : '(none — month filter OFF)',
        assigneeCol: assigneeIdx >= 0 ? headers[assigneeIdx] : '(none)',
        subjectCol: subjectIdx >= 0 ? headers[subjectIdx] : '(none — scanning whole row)',
        ticketCol: ticketIdx >= 0 ? headers[ticketIdx] : '(none — no ticket links)',
        emailCol: emailIdx >= 0 ? headers[emailIdx] : '(none — email match OFF)',
        monthKept: keptRows.length,
        totalRows: dataRows.length,
        monthFiltered,
        columns,
      })
    } catch (err: any) {
      setZ({ name: f.name, error: 'Could not read that file: ' + (err?.message || err) })
    }
  }

  function exportCSV() {
    const head = [
      'Order', 'Date', 'Customer', 'Total', 'Financial', 'Fulfillment',
      'Matched by', 'Matched email', 'Ticket', 'Ticket URL', 'Matched phone',
      'Channels', 'Credited', 'Tagged channels', 'Wrong channel', 'Tags',
    ]
    const data = [
      head,
      ...rows.map((o) => [
        o.name, (o.createdAt || '').slice(0, 10), o.customer, o.total.toFixed(2), o.financial, o.fulfillment,
        o.matchedEmail ? 'email' : '', o.matchedEmail || '',
        o.ticketId || '', o.ticketId ? ZENDESK_TICKET_URL + o.ticketId : '',
        o.matchedPhone ? fmtPhone(o.matchedPhone) : '',
        o.matchChannels.join('+'), o.yourTag ? 'yes' : 'no', o.taggedChannels.join('+'), o.channelMismatch ? 'yes' : '', o.tags,
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

  const cov = report?.coverage
  const assigneeActive = !!assignee.trim() && (z.assigneeIdx ?? -1) >= 0

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
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </select>
          <a href="/sales" className="icon-btn">Sales →</a>
          <a href="/" className="icon-btn">Home</a>
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

            {cov && (
              <div className="attr-cov">
                Shopify data: email on <b>{cov.withEmail}</b>/{cov.total} · phone on <b>{cov.withPhone}</b>/{cov.total}
                {cov.withPhone === 0 && ' · phone redacted (RingCentral matching needs Shopify Protected Customer Data). Order-number matching below is unaffected.'}
              </div>
            )}

            <div className="attr-zone">
              <div style={{ flex: 1, minWidth: 240 }}>
                <strong>Zendesk email match:</strong>{' '}
                {z.keptRows ? (
                  <span className={orders.filter((o) => o.matchedEmail).length > 0 ? 'attr-ok' : 'attr-warn-inline'}>
                    {orders.filter((o) => o.matchedEmail).length} order
                    {orders.filter((o) => o.matchedEmail).length === 1 ? '' : 's'} matched from {zDerived.ticketsUsed}{' '}
                    ticket{zDerived.ticketsUsed === 1 ? '' : 's'}
                    {z.monthFiltered ? ` in ${monthLabel}` : ' (no date column — month filter OFF)'}
                    {assigneeActive ? ` · assignee ~ “${assignee.trim()}”` : ''}
                    {` · ${zDerived.emails.size} unique emails`}
                    {(z.ticketIdx ?? -1) >= 0 ? ' · ✉ opens the ticket' : ' · no ticket-id column, links off'}
                  </span>
                ) : z.error ? (
                  <span className="attr-warn-inline">{z.error}</span>
                ) : (
                  <span className="attr-muted">
                    not loaded — upload the Zendesk CSV with <b>Requester Email</b> + <b>Ticket ID</b>; it’s filtered to {monthLabel}.
                  </span>
                )}
                {z.name && (
                  <div className="attr-detect">
                    {z.name} · email: <b>{z.emailCol}</b> · ticket: <b>{z.ticketCol}</b> · date: <b>{z.dateCol}</b>
                  </div>
                )}
                <div style={{ marginTop: 8 }}>
                  <input
                    className="attr-search"
                    style={{ width: 240 }}
                    placeholder="limit to assignee (your name) — optional"
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                  />
                </div>
              </div>
              <label className="btn btn-sm">
                {z.keptRows ? 'Replace CSV' : 'Load Zendesk CSV'}
                <input type="file" accept=".csv,.txt,.tsv" onChange={onFile} style={{ display: 'none' }} />
              </label>
            </div>

            {z.columns && (
              <details className="attr-cols">
                <summary>What’s in this file — {z.columns.length} columns (fullest first)</summary>
                <div className="attr-cols-body">
                  {[...z.columns]
                    .sort((a, b) => b.filled - a.filled)
                    .map((c, i) => (
                      <div key={i} className={'attr-col' + (c.filled === 0 ? ' empty' : '')}>
                        <span className="cn">{c.name || '(unnamed)'}</span>
                        <span className="cf">{c.filled}/{c.total}{c.isEmail ? ' · email' : ''}</span>
                        <span className="cs">{c.sample || '—'}</span>
                      </div>
                    ))}
                </div>
              </details>
            )}

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
              <button className="btn btn-sm" onClick={exportCSV}>Export CSV</button>
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
                        <div className="empty" style={{ padding: 24 }}>Nothing in this view.</div>
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
                        {o.ticketId ? (
                          <a
                            className="attr-ch on attr-ch-link"
                            href={ZENDESK_TICKET_URL + o.ticketId}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={
                              'Open ticket #' +
                              o.ticketId +
                              (o.ticketSubject ? ' — ' + o.ticketSubject : '') +
                              ' (matched ' + (o.matchedEmail || '') + ')'
                            }
                          >
                            ✉
                          </a>
                        ) : (
                          <span
                            className={'attr-ch' + (o.matchedEmail ? ' on' : '')}
                            title={o.matchedEmail ? 'email ' + o.matchedEmail + ' (no ticket id in CSV)' : 'no support match'}
                          >
                            ✉
                          </span>
                        )}
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
                          <span className="bdg b-w" style={{ marginLeft: 6 }}>⚠ {o.matchChannels.join('/')}</span>
                        )}
                      </td>
                      <td>
                        {o.tags ? (
                          o.tags.split(',').map((t, i) => (
                            <span key={i} className="tag-p">{t.trim()}</span>
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
              OPS DASHBOARD · ATTRIBUTION · {monthLabel} · pulled {new Date(report.generatedAt).toLocaleString()}
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
.attr-warn-inline{color:var(--warn-text)}
.attr-cov{font-size:11.5px;color:var(--text2);font-family:var(--font-mono);margin:12px 0 0;padding:8px 12px;background:var(--bg2);border:1px solid var(--border);border-radius:8px}
.attr-zone{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:12px 0;font-size:12px;color:var(--text)}
.attr-detect{font-size:11px;color:var(--text3);font-family:var(--font-mono);margin-top:6px}
.attr-detect b{color:var(--text2)}
.attr-cols{margin:10px 0;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px 14px}
.attr-cols>summary{cursor:pointer;font-size:12px;color:var(--text);font-weight:600;user-select:none}
.attr-cols-body{margin-top:10px;max-height:320px;overflow:auto;font-family:var(--font-mono);font-size:11.5px}
.attr-col{display:grid;grid-template-columns:minmax(140px,1fr) 140px minmax(120px,1.4fr);gap:10px;padding:5px 0;border-top:1px solid var(--border);align-items:baseline}
.attr-col .cn{color:var(--text)}
.attr-col .cf{color:var(--accent)}
.attr-col .cs{color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.attr-col.empty .cn{color:var(--text3)}
.attr-col.empty .cf{color:var(--text3)}
.attr-ok{color:var(--green)}
.attr-muted{color:var(--text2)}
.kpi.attr-flag{border-color:rgba(232,93,36,.4)}
.kpi.attr-flag .value{color:var(--accent)}
.attr-tabs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--border);margin-top:8px}
.attr-search{background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;width:150px;font-family:var(--font-mono)}
.attr-ch{color:var(--text3)}
.attr-ch.on{color:var(--accent)}
a.attr-ch-link{text-decoration:none;cursor:pointer;border-bottom:1px dotted transparent}
a.attr-ch-link:hover{border-bottom-color:var(--accent)}
.dfu-tbl.attr-tbl th{width:auto!important}
.attr-tbl .num{font-family:var(--font-mono);text-align:right}
.attr-tbl tbody tr.attr-r-unc td{background:rgba(232,93,36,.06)}
`

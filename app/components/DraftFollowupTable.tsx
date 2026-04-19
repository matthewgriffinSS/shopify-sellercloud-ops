'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import type { DraftFollowupRow } from '@/lib/queries'
import { formatMoney } from './shared'

type Field =
  | 'email_followup'
  | 'sms_followup'
  | 'phone_followup'
  | 'richpanel_link'
  | 'rep_notes'
  | 'can_delete'

type Row = DraftFollowupRow & { _err?: string }

type TabId = 'all' | 'stale' | 'first_touch'

const TABS: Array<{ id: TabId; label: string; hint: string }> = [
  { id: 'all', label: 'All', hint: 'Every invoiced draft for this rep' },
  { id: 'stale', label: 'Stale', hint: '7+ days old, no follow-up yet' },
  { id: 'first_touch', label: 'Needs first touch', hint: 'No email, SMS, or call logged' },
]

/**
 * Spreadsheet-style follow-up editor for a single rep's invoiced drafts.
 *
 * Columns: Invoice # · Phone · Date Created · Tags · Email · SMS · SMS Date ·
 *          Phone · Phone Date · Richpanel · Notes · Close Out · Draft ID
 *
 * Auto-hidden from this view (via the server query):
 *  - Drafts that Shopify converted to a real order (converted_order_id set)
 *  - Drafts the rep manually closed out (can_delete = true)
 *  - Drafts with service tags (sdss / install / rebuild / shock service)
 *  - Anything older than 60 days
 *
 * Every change POSTs to /api/actions/draft-followup. The UI updates
 * optimistically and reverts on error.
 */
export function DraftFollowupTable({ rows: initialRows }: { rows: DraftFollowupRow[] }) {
  const router = useRouter()
  const [rows, setRows] = useState<Row[]>(initialRows)
  const [activeTab, setActiveTab] = useState<TabId>('all')
  const [, startTransition] = useTransition()

  useEffect(() => {
    setRows(initialRows)
  }, [initialRows])

  // Compute filtered rows and per-tab counts. Recomputed when rows change.
  const { filteredRows, counts } = useMemo(() => {
    const counts: Record<TabId, number> = { all: 0, stale: 0, first_touch: 0 }
    for (const r of rows) {
      counts.all += 1
      if (isStale(r)) counts.stale += 1
      if (isNeedsFirstTouch(r)) counts.first_touch += 1
    }
    const filteredRows =
      activeTab === 'stale'
        ? rows.filter(isStale)
        : activeTab === 'first_touch'
          ? rows.filter(isNeedsFirstTouch)
          : rows
    return { filteredRows, counts }
  }, [rows, activeTab])

  async function patch(id: string, field: Field, value: boolean | string | null) {
    const prev = rows.find((r) => r.id === id)
    if (!prev) return

    setRows((cur) => cur.map((r) => (r.id === id ? applyLocal(r, field, value) : r)))

    try {
      const res = await fetch('/api/actions/draft-followup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, field, value }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Save failed')
      startTransition(() => router.refresh())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setRows((cur) => cur.map((r) => (r.id === id ? { ...prev, _err: message } : r)))
    }
  }

  return (
    <>
      <div className="dfu-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`dfu-tab${activeTab === t.id ? ' dfu-tab-on' : ''}`}
            onClick={() => setActiveTab(t.id)}
            title={t.hint}
          >
            {t.label}
            <span className="dfu-tab-ct">{counts[t.id]}</span>
          </button>
        ))}
      </div>

      {filteredRows.length === 0 ? (
        <div className="empty">{emptyMessageFor(activeTab)}</div>
      ) : (
        <div className="dfu-wrap">
          <table className="dfu-tbl">
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Phone #</th>
                <th>Date Created</th>
                <th>Tags</th>
                <th title="Email follow-up">Email</th>
                <th title="SMS follow-up">SMS</th>
                <th>SMS Date</th>
                <th title="Phone follow-up">Phone</th>
                <th>Phone Date</th>
                <th>Richpanel</th>
                <th>Notes</th>
                <th title="Close out off-Shopify sales or dismissed drafts">Close Out</th>
                <th>Draft ID</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => (
                <DraftRow key={r.id} row={r} onChange={patch} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="dfu-hint">
        Converted drafts disappear automatically when Shopify reports them as orders.
        Use <b>Close Out</b> to hide off-Shopify sales (phone/check) or drafts that won&rsquo;t
        convert. Changes save as you edit.
      </div>
    </>
  )
}

// -------- Tab filter predicates --------

const STALE_MS = 7 * 24 * 60 * 60 * 1000

function isStale(r: DraftFollowupRow): boolean {
  const created = toDate(r.shopify_created_at)
  if (!created) return false
  const ageMs = Date.now() - created.getTime()
  if (ageMs < STALE_MS) return false
  // "Stale" is old AND no follow-up yet. A rep who's already chased this
  // draft knows the ball's in the customer's court.
  return !hasAnyFollowup(r)
}

function isNeedsFirstTouch(r: DraftFollowupRow): boolean {
  return !hasAnyFollowup(r)
}

function hasAnyFollowup(r: DraftFollowupRow): boolean {
  return r.email_followup || r.sms_followup || r.phone_followup
}

function emptyMessageFor(tab: TabId): string {
  switch (tab) {
    case 'stale':
      return 'Nothing stale. Every draft 7+ days old has at least one follow-up logged.'
    case 'first_touch':
      return 'Every draft has at least one follow-up logged. Nice.'
    case 'all':
      return 'No invoiced drafts for this rep in the last 60 days.'
  }
}

// -------- Row rendering --------

function applyLocal(r: Row, field: Field, value: boolean | string | null): Row {
  const bool = value === true
  const now = new Date()
  switch (field) {
    case 'email_followup':
      return { ...r, email_followup: bool, _err: undefined }
    case 'sms_followup':
      return {
        ...r,
        sms_followup: bool,
        sms_date: bool ? (r.sms_date ?? now) : null,
        _err: undefined,
      }
    case 'phone_followup':
      return {
        ...r,
        phone_followup: bool,
        phone_call_date: bool ? (r.phone_call_date ?? now) : null,
        _err: undefined,
      }
    case 'can_delete':
      return { ...r, can_delete: bool, _err: undefined }
    case 'richpanel_link':
      return { ...r, richpanel_link: typeof value === 'string' ? value : null, _err: undefined }
    case 'rep_notes':
      return { ...r, rep_notes: typeof value === 'string' ? value : null, _err: undefined }
  }
}

function DraftRow({
  row,
  onChange,
}: {
  row: Row
  onChange: (id: string, field: Field, value: boolean | string | null) => void
}) {
  return (
    <tr className={row._err ? 'dfu-err' : undefined}>
      <td className="dfu-inv">{row.name}</td>
      <td className="dfu-phone">{row.customer_phone ?? '(blank)'}</td>
      <td className="dfu-date">{fmtDateTime(row.shopify_created_at)}</td>
      <td className="dfu-tags">
        {row.tags.length === 0 ? (
          <span className="dfu-muted">—</span>
        ) : (
          row.tags.map((t) => (
            <span key={t} className="tag-p">
              {t}
            </span>
          ))
        )}
      </td>
      <td>
        <input
          type="checkbox"
          checked={row.email_followup}
          onChange={(e) => onChange(row.id, 'email_followup', e.target.checked)}
        />
      </td>
      <td>
        <input
          type="checkbox"
          checked={row.sms_followup}
          onChange={(e) => onChange(row.id, 'sms_followup', e.target.checked)}
        />
      </td>
      <td className="dfu-date">{fmtDate(row.sms_date)}</td>
      <td>
        <input
          type="checkbox"
          checked={row.phone_followup}
          onChange={(e) => onChange(row.id, 'phone_followup', e.target.checked)}
        />
      </td>
      <td className="dfu-date">{fmtDate(row.phone_call_date)}</td>
      <td>
        <DebouncedInput
          value={row.richpanel_link ?? ''}
          onCommit={(v) => onChange(row.id, 'richpanel_link', v)}
          placeholder="URL"
          type="url"
        />
        {row.richpanel_link && (
          <a
            href={row.richpanel_link}
            target="_blank"
            rel="noreferrer"
            className="dfu-link"
            title="Open link"
          >
            ↗
          </a>
        )}
      </td>
      <td>
        <DebouncedInput
          value={row.rep_notes ?? ''}
          onCommit={(v) => onChange(row.id, 'rep_notes', v)}
          placeholder="Notes"
          type="text"
        />
      </td>
      <td>
        <input
          type="checkbox"
          checked={row.can_delete}
          onChange={(e) => onChange(row.id, 'can_delete', e.target.checked)}
          title="Hide this draft from the follow-up view"
        />
      </td>
      <td className="dfu-id">
        {row.id}
        <div className="dfu-value">{formatMoney(row.total_price)}</div>
        {row._err && <div className="dfu-errmsg">{row._err}</div>}
      </td>
    </tr>
  )
}

// -------- Utility helpers --------

function toDate(d: Date | string | null): Date | null {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  return isNaN(date.getTime()) ? null : date
}

function fmtDate(d: Date | string | null): string {
  const date = toDate(d)
  return date ? date.toISOString().slice(0, 16).replace('T', ' ') : ''
}

function fmtDateTime(d: Date | string | null): string {
  const date = toDate(d)
  return date ? date.toISOString().replace(/\.\d{3}Z$/, 'Z') : ''
}

/**
 * Text input that commits changes 500ms after the user stops typing,
 * so we're not POSTing on every keystroke.
 */
function DebouncedInput({
  value: initial,
  onCommit,
  placeholder,
  type,
}: {
  value: string
  onCommit: (value: string) => void
  placeholder?: string
  type: 'text' | 'url'
}) {
  const [v, setV] = useState(initial)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const committed = useRef(initial)

  useEffect(() => {
    setV(initial)
    committed.current = initial
  }, [initial])

  function handleChange(next: string) {
    setV(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (next !== committed.current) {
        committed.current = next
        onCommit(next)
      }
    }, 500)
  }

  function handleBlur() {
    if (timer.current) clearTimeout(timer.current)
    if (v !== committed.current) {
      committed.current = v
      onCommit(v)
    }
  }

  return (
    <input
      type={type}
      value={v}
      placeholder={placeholder}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={handleBlur}
      className="dfu-input"
    />
  )
}

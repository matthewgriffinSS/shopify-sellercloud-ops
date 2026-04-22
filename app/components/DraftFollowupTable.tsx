'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import type { DraftFollowupRow } from '@/lib/queries'
import { formatMoney } from './shared'
import { confirmDialog } from './ConfirmDialog'

type Field =
  | 'email_followup'
  | 'sms_followup'
  | 'phone_followup'
  | 'richpanel_link'
  | 'rep_notes'
  | 'can_delete'
  | 'reset_followups'

type Row = DraftFollowupRow & { _err?: string }

type TabId = 'needs_followup' | 'waiting'

const TABS: Array<{ id: TabId; label: string; hint: string }> = [
  { id: 'needs_followup', label: 'Needs follow-up', hint: 'No SMS or call logged yet' },
  { id: 'waiting', label: 'Waiting', hint: 'Follow-up logged. Waiting on customer.' },
]

/**
 * Spreadsheet-style follow-up editor for a single rep's invoiced drafts.
 *
 * Columns: Invoice # · Amount · Email · Phone # · Date Created · SMS ·
 *          SMS Date · Phone · Phone Date · Richpanel · Notes · Actions
 *
 * Email is shown as a mailto: link so reps can copy or click through without
 * leaving the dashboard. The actual email invoice sending is still handled by
 * Shopify Flow "Draft Auto Reply" on a weekly schedule (invoice-sent:1/:2 tags),
 * so there's no email follow-up checkbox — just the address for reference.
 *
 * Two tabs:
 *  - Needs follow-up: no SMS or phone call logged yet
 *  - Waiting: at least one follow-up logged
 *
 * Auto-hidden from this view (via the server query):
 *  - Drafts that Shopify converted to a real order (converted_order_id set)
 *  - Drafts the rep manually closed out (can_delete = true)
 *  - Drafts with service tags (sdss / install / rebuild / shock service)
 *  - Anything older than 30 days
 *
 * Every change POSTs to /api/actions/draft-followup. The UI updates
 * optimistically and reverts on error.
 */
export function DraftFollowupTable({
  rows: initialRows,
  storeDomain,
}: {
  rows: DraftFollowupRow[]
  storeDomain: string | null
}) {
  const router = useRouter()
  const [rows, setRows] = useState<Row[]>(initialRows)
  const [activeTab, setActiveTab] = useState<TabId>('needs_followup')
  const [, startTransition] = useTransition()

  useEffect(() => {
    setRows(initialRows)
  }, [initialRows])

  // Compute filtered rows and per-tab counts. Recomputed when rows change.
  const { filteredRows, counts } = useMemo(() => {
    const counts: Record<TabId, number> = { needs_followup: 0, waiting: 0 }
    for (const r of rows) {
      if (hasAnyFollowup(r)) counts.waiting += 1
      else counts.needs_followup += 1
    }
    const filteredRows =
      activeTab === 'waiting' ? rows.filter(hasAnyFollowup) : rows.filter(isNeedsFollowup)
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
                <th>Amount</th>
                <th>Email</th>
                <th>Phone #</th>
                <th>Date Created</th>
                <th title="SMS follow-up">SMS</th>
                <th>SMS Date</th>
                <th title="Phone follow-up">Phone</th>
                <th>Phone Date</th>
                <th>Richpanel</th>
                <th>Notes</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => (
                <DraftRow key={r.id} row={r} onChange={patch} storeDomain={storeDomain} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="dfu-hint">
        Converted drafts disappear automatically when Shopify reports them as orders.
        Use <b>↻ Chase</b> to clear follow-ups and chase again, or <b>✕ Close</b> to
        hide a draft that won&rsquo;t convert.
      </div>
    </>
  )
}

// -------- Tab filter predicates --------

function isNeedsFollowup(r: DraftFollowupRow): boolean {
  return !hasAnyFollowup(r)
}

function hasAnyFollowup(r: DraftFollowupRow): boolean {
  // Shopify Flow sends invoices automatically on a weekly schedule (see
  // invoice-sent:1 / :2 tags) — a rep doesn't log "I emailed them," so only
  // SMS and Phone, which the rep actually drives, determine tab placement.
  return r.sms_followup || r.phone_followup
}

function emptyMessageFor(tab: TabId): string {
  switch (tab) {
    case 'needs_followup':
      return 'Nothing needs follow-up. Every draft has at least one contact logged.'
    case 'waiting':
      return 'Nothing waiting. No drafts have been followed up yet.'
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
    case 'reset_followups':
      // Clears all three follow-up flags + their dates, returning the row
      // to the Needs follow-up tab. Useful when a customer went cold and
      // the rep wants to chase again.
      return {
        ...r,
        email_followup: false,
        sms_followup: false,
        sms_date: null,
        phone_followup: false,
        phone_call_date: null,
        _err: undefined,
      }
  }
}

function DraftRow({
  row,
  onChange,
  storeDomain,
}: {
  row: Row
  onChange: (id: string, field: Field, value: boolean | string | null) => void
  storeDomain: string | null
}) {
  const draftUrl = storeDomain ? `https://${storeDomain}/admin/draft_orders/${row.id}` : null
  const waiting = hasAnyFollowup(row)

  return (
    <tr className={row._err ? 'dfu-err' : undefined}>
      <td className="dfu-inv">
        {draftUrl ? (
          <a href={draftUrl} target="_blank" rel="noreferrer" className="dfu-inv-link">
            {row.name}
          </a>
        ) : (
          row.name
        )}
      </td>
      <td className="dfu-amt">{formatMoney(row.total_price)}</td>
      <td className="dfu-email">
        {row.customer_email ? (
          <a
            href={`mailto:${row.customer_email}`}
            className="dfu-email-link"
            title={row.customer_email}
          >
            {row.customer_email}
          </a>
        ) : (
          <span className="dfu-blank">(blank)</span>
        )}
      </td>
      <td className="dfu-phone">
        {row.customer_phone ?? <span className="dfu-blank">(blank)</span>}
      </td>
      <td className="dfu-date">{fmtDate(row.shopify_created_at)}</td>
      <td className="dfu-check">
        <input
          type="checkbox"
          checked={row.sms_followup}
          onChange={(e) => onChange(row.id, 'sms_followup', e.target.checked)}
        />
      </td>
      <td className="dfu-date">{fmtDate(row.sms_date)}</td>
      <td className="dfu-check">
        <input
          type="checkbox"
          checked={row.phone_followup}
          onChange={(e) => onChange(row.id, 'phone_followup', e.target.checked)}
        />
      </td>
      <td className="dfu-date">{fmtDate(row.phone_call_date)}</td>
      <td>
        <div className="dfu-link-cell">
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
        </div>
      </td>
      <td>
        <DebouncedInput
          value={row.rep_notes ?? ''}
          onCommit={(v) => onChange(row.id, 'rep_notes', v)}
          placeholder="Notes"
          type="text"
        />
        {row._err && <div className="dfu-errmsg">{row._err}</div>}
      </td>
      <td>
        <div className="dfu-actions">
          {waiting && (
            <button
              type="button"
              className="btn-sm dfu-btn-chase"
              onClick={async () => {
                const ok = await confirmDialog({
                  title: `Chase ${row.name} again?`,
                  message:
                    'This clears the SMS and Phone checkmarks and dates so you ' +
                    'can log a new round of follow-ups. The draft returns to the ' +
                    'Needs follow-up tab.',
                  confirmLabel: '↻ Chase',
                })
                if (ok) onChange(row.id, 'reset_followups', true)
              }}
              title="Clear follow-ups so you can chase this draft again"
            >
              ↻ Chase
            </button>
          )}
          <button
            type="button"
            className="btn-sm dfu-btn-close"
            onClick={async () => {
              const ok = await confirmDialog({
                title: `Close out ${row.name}?`,
                message:
                  'This hides the draft permanently. Use for phone/check sales ' +
                  '(paid outside Shopify) or dead leads.',
                confirmLabel: '✕ Close out',
                destructive: true,
              })
              if (ok) onChange(row.id, 'can_delete', true)
            }}
            title="Hide this draft permanently"
          >
            ✕ Close
          </button>
        </div>
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

/**
 * Format as mm/dd/yy in the viewer's local timezone. Using local time
 * (not UTC) means a draft created at 11pm Eastern displays as the same
 * date the rep actually remembers working on it.
 */
function fmtDate(d: Date | string | null): string {
  const date = toDate(d)
  if (!date) return ''
  return date.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  })
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

'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import type { DraftFollowupRow } from '@/lib/queries'
import { formatMoney } from './shared'

type Field =
  | 'followed_up'
  | 'email_followup'
  | 'sms_followup'
  | 'phone_followup'
  | 'converted'
  | 'richpanel_link'
  | 'rep_notes'
  | 'can_delete'

type Row = DraftFollowupRow & { _err?: string }

/**
 * Spreadsheet-style follow-up editor. Mirrors the columns from the old
 * "Draft Order Follow Up" Google Sheet (Invoice / Email / Phone / Date /
 * Tags / Followed Up / Converted / eMail FU / SMS FU / SMS Date /
 * Phone FU / Phone Call Date / Richpanel Link / Notes / Can Delete /
 * Draft Order ID).
 *
 * Every change POSTs to /api/actions/draft-followup. The UI updates
 * optimistically and reverts on error.
 */
export function DraftFollowupTable({ rows: initialRows }: { rows: DraftFollowupRow[] }) {
  const router = useRouter()
  const [rows, setRows] = useState<Row[]>(initialRows)
  const [, startTransition] = useTransition()

  // Keep local state in sync when the server re-renders with fresh data.
  useEffect(() => {
    setRows(initialRows)
  }, [initialRows])

  async function patch(id: string, field: Field, value: boolean | string | null) {
    // Snapshot the previous value so we can roll back on failure.
    const prev = rows.find((r) => r.id === id)
    if (!prev) return

    // Optimistic local update.
    setRows((cur) =>
      cur.map((r) => (r.id === id ? applyLocal(r, field, value) : r)),
    )

    try {
      const res = await fetch('/api/actions/draft-followup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, field, value }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Save failed')

      // Refresh server data so fields like sms_date / can_delete-hiding get
      // the server's authoritative values back.
      startTransition(() => router.refresh())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setRows((cur) =>
        cur.map((r) => (r.id === id ? { ...prev, _err: message } : r)),
      )
    }
  }

  if (rows.length === 0) {
    return <div className="empty">No invoiced drafts for this rep in the last 60 days.</div>
  }

  return (
    <div className="dfu-wrap">
      <table className="dfu-tbl">
        <thead>
          <tr>
            <th>Invoice #</th>
            <th>Email</th>
            <th>Phone #</th>
            <th>Date Created</th>
            <th>Tags</th>
            <th title="Followed up">FU</th>
            <th title="Converted">Conv</th>
            <th title="Email follow-up">eMail</th>
            <th title="SMS follow-up">SMS</th>
            <th>SMS Date</th>
            <th title="Phone follow-up">Phone</th>
            <th>Phone Date</th>
            <th>Richpanel</th>
            <th>Notes</th>
            <th title="Can delete">Del</th>
            <th>Draft ID</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <DraftRow key={r.id} row={r} onChange={patch} />
          ))}
        </tbody>
      </table>
      <div className="dfu-hint">
        Checking <b>Del</b> hides the row from this view. Changes save as you edit.
      </div>
    </div>
  )
}

function applyLocal(r: Row, field: Field, value: boolean | string | null): Row {
  const bool = value === true
  const now = new Date()
  switch (field) {
    case 'followed_up':
      return { ...r, followed_up: bool, _err: undefined }
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
    case 'converted':
      return {
        ...r,
        converted_at: bool ? (r.converted_at ?? now) : null,
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
  const isConverted = row.converted_at !== null || row.converted_order_id !== null

  return (
    <tr className={row._err ? 'dfu-err' : undefined}>
      <td className="dfu-inv">{row.name}</td>
      <td className="dfu-email">{row.customer_email ?? '—'}</td>
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
          checked={row.followed_up}
          onChange={(e) => onChange(row.id, 'followed_up', e.target.checked)}
        />
      </td>
      <td>
        <input
          type="checkbox"
          checked={isConverted}
          onChange={(e) => onChange(row.id, 'converted', e.target.checked)}
          title={
            row.converted_order_id
              ? `Converted to order ${row.converted_order_id}`
              : row.converted_at
                ? `Marked converted ${fmtDateTime(row.converted_at)}`
                : 'Mark converted'
          }
        />
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
          title="Hide this row from the follow-up view"
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

function fmtDate(d: Date | string | null): string {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  if (isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

function fmtDateTime(d: Date | string | null): string {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  if (isNaN(date.getTime())) return ''
  // Match the sheet format: 2025-12-02T19:09:17Z
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
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

  // Sync down when the server value changes from outside.
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

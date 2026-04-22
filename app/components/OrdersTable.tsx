'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { daysAgo, formatMoney } from './shared'
import { confirmDialog } from './ConfirmDialog'

/**
 * Single shared client-side table used by LateFulfillments and VipOrders.
 *
 * Why client-side now: optimistic UI for "Mark handled" requires local state
 * we can update immediately, and inline note expansion is much cleaner with
 * client interactivity. The server wrappers fetch the data and pass it in
 * as initial state.
 *
 * Variant switches column layout — late tables get a "Late N days" column,
 * VIP tables get a VIP badge in the customer cell. Otherwise identical.
 */

export type OrderRow = {
  id: string
  order_number: string
  customer_name: string | null
  total_price: string
  shopify_created_at: string // ISO string after JSON serialization
  sellercloud_order_id: string | null
  fulfillment_status?: string | null
}

type Props = {
  variant: 'late' | 'vip'
  initialRows: OrderRow[]
  initialNotes: Record<string, string | null>
  initialInProgress: Record<string, boolean>
  storeDomain: string | null
  scAdminUrl: string | null
}

const NOTE_DISPLAY_MAX = 70

export function OrdersTable({
  variant,
  initialRows,
  initialNotes,
  initialInProgress,
  storeDomain,
  scAdminUrl,
}: Props) {
  const router = useRouter()
  const [rows, setRows] = useState(initialRows)
  const [notesByOrder, setNotesByOrder] = useState(initialNotes)
  const [inProgress, setInProgress] = useState(initialInProgress)
  const [openNoteFor, setOpenNoteFor] = useState<string | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())

  // If the server sends fresh data after router.refresh(), reconcile.
  useEffect(() => {
    setRows(initialRows)
    setNotesByOrder(initialNotes)
    setInProgress(initialInProgress)
  }, [initialRows, initialNotes, initialInProgress])

  function setRowPending(id: string, isPending: boolean) {
    setPending((cur) => {
      const next = new Set(cur)
      if (isPending) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function markHandled(row: OrderRow) {
    const ok = await confirmDialog({
      title: `Mark #${row.order_number} handled?`,
      message:
        'This order will disappear from both the Late and VIP tables. ' +
        'You can undo by deleting the processing_actions row in the DB.',
      confirmLabel: '✓ Mark handled',
    })
    if (!ok) return

    // Optimistic: yank the row immediately.
    const previousRows = rows
    setRows((cur) => cur.filter((r) => r.id !== row.id))
    setRowPending(row.id, true)

    try {
      const res = await fetch('/api/actions/process-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceType: 'order',
          resourceId: row.id,
          actionType: 'mark_processed',
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.scError || data.error || 'Failed to mark handled')
      // Refresh the server data so metrics + other tables stay in sync.
      router.refresh()
    } catch (err) {
      // Restore the row and surface the error.
      setRows(previousRows)
      window.alert(
        `Failed to mark handled: ${err instanceof Error ? err.message : 'unknown error'}`,
      )
    } finally {
      setRowPending(row.id, false)
    }
  }

  async function saveNote(row: OrderRow, noteText: string) {
    const trimmed = noteText.trim()
    if (!trimmed) return

    const previousNote = notesByOrder[row.id] ?? null
    const previousInProgress = inProgress[row.id] ?? false

    // Optimistic: show the new note immediately, close the form.
    setNotesByOrder((cur) => ({ ...cur, [row.id]: trimmed }))
    setInProgress((cur) => ({ ...cur, [row.id]: true }))
    setOpenNoteFor(null)
    setRowPending(row.id, true)

    try {
      const res = await fetch('/api/actions/process-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceType: 'order',
          resourceId: row.id,
          actionType: 'add_note',
          note: trimmed,
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.scError || data.error || 'Failed to save note')
      router.refresh()
    } catch (err) {
      // Restore the previous note and re-flag.
      setNotesByOrder((cur) => ({ ...cur, [row.id]: previousNote }))
      setInProgress((cur) => ({ ...cur, [row.id]: previousInProgress }))
      window.alert(
        `Failed to save note: ${err instanceof Error ? err.message : 'unknown error'}`,
      )
    } finally {
      setRowPending(row.id, false)
    }
  }

  // Number of cells in a row, used for the colSpan on the expansion row.
  const colCount = variant === 'late' ? 7 : 6

  if (rows.length === 0) {
    return (
      <div className="empty">
        {variant === 'late'
          ? 'No late fulfillments. Nice.'
          : 'No VIP orders this week.'}
      </div>
    )
  }

  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: variant === 'late' ? '10%' : '11%' }}>Order</th>
          <th style={{ width: '10%' }}>SC</th>
          <th style={{ width: variant === 'late' ? '20%' : '24%' }}>Customer</th>
          {variant === 'late' && <th style={{ width: '8%' }}>Late</th>}
          <th style={{ width: '11%' }}>Value</th>
          <th>Status</th>
          <th style={{ width: '20%' }} className="r">
            Action
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const days = daysAgo(new Date(r.shopify_created_at))
          const lateBadge = days >= 7 ? 'b-d' : 'b-w'
          const isOpen = openNoteFor === r.id
          const isPending = pending.has(r.id)
          const note = notesByOrder[r.id] ?? null
          const showInProgress = !note && inProgress[r.id]

          return (
            <Fragment key={r.id}>
              <tr className={isOpen ? 'row-open' : ''}>
                <td>
                  {storeDomain ? (
                    <a
                      href={`https://${storeDomain}/admin/orders/${r.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="dfu-inv-link"
                    >
                      #{r.order_number}
                    </a>
                  ) : (
                    <>#{r.order_number}</>
                  )}
                </td>
                <td>
                  {r.sellercloud_order_id && scAdminUrl ? (
                    <a
                      href={`${scAdminUrl}/orders/order-details.aspx?id=${r.sellercloud_order_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="dfu-inv-link"
                    >
                      SC-{r.sellercloud_order_id}
                    </a>
                  ) : (
                    <span style={{ color: 'var(--text3)' }}>—</span>
                  )}
                </td>
                <td>
                  {r.customer_name ?? '—'}
                  {variant === 'vip' && <span className="bdg b-i" style={{ marginLeft: 6 }}>VIP</span>}
                </td>
                {variant === 'late' && (
                  <td>
                    <span className={`bdg ${lateBadge}`}>{days}d</span>
                  </td>
                )}
                <td>{formatMoney(r.total_price)}</td>
                <td>
                  {note ? (
                    <span className="row-note" title={note}>
                      <span className="row-note-ic">💬</span>
                      <span className="row-note-text">
                        {note.length > NOTE_DISPLAY_MAX
                          ? `${note.slice(0, NOTE_DISPLAY_MAX).trimEnd()}…`
                          : note}
                      </span>
                    </span>
                  ) : showInProgress ? (
                    <span className="bdg b-w">In progress</span>
                  ) : (
                    <span className="bdg b-d">Needs action</span>
                  )}
                </td>
                <td className="r">
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn-row-note"
                      onClick={() => setOpenNoteFor(isOpen ? null : r.id)}
                      disabled={isPending}
                    >
                      {note ? 'Edit note' : 'Note'}
                    </button>
                    <button
                      type="button"
                      className="btn-row-handled"
                      onClick={() => markHandled(r)}
                      disabled={isPending}
                      title="Mark this order handled and remove from both tables"
                    >
                      ✓ Mark handled
                    </button>
                  </div>
                </td>
              </tr>

              {isOpen && (
                <tr className="row-form">
                  <td colSpan={colCount}>
                    <NoteForm
                      orderLabel={`#${r.order_number} — ${r.customer_name ?? 'customer'} · ${formatMoney(r.total_price)}`}
                      initialNote={note ?? ''}
                      onSave={(text) => saveNote(r, text)}
                      onCancel={() => setOpenNoteFor(null)}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * Inline note editor that lives inside the expanded row.
 * Local state for the textarea so each open row has its own draft.
 */
function NoteForm({
  orderLabel,
  initialNote,
  onSave,
  onCancel,
}: {
  orderLabel: string
  initialNote: string
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initialNote)
  const ref = useRef<HTMLTextAreaElement>(null)

  // Autofocus on open so the rep can start typing immediately.
  useEffect(() => {
    ref.current?.focus()
    // Place cursor at end so editing existing notes works naturally.
    if (ref.current && initialNote) {
      ref.current.setSelectionRange(initialNote.length, initialNote.length)
    }
  }, [initialNote])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl + Enter saves; Esc cancels. Quality of life for power users.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      onSave(text)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="row-form-content">
      <div className="row-form-label">
        Note for <strong>{orderLabel}</strong>
      </div>
      <textarea
        ref={ref}
        className="row-form-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="What's the situation? (Cmd+Enter to save, Esc to cancel)"
        rows={3}
      />
      <div className="row-form-buttons">
        <button
          type="button"
          className="btn-sm btn-primary"
          onClick={() => onSave(text)}
          disabled={text.trim().length === 0}
        >
          Save note
        </button>
        <button type="button" className="btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatMoney, timeAgo } from './shared'

/**
 * Client-side grid for abandoned carts. Same pattern as OrdersTable:
 *   - Two buttons per card: Note + Mark handled
 *   - Mark handled is one click (+ confirm), removes the card optimistically
 *   - Note opens an inline form INSIDE the card (card grows taller)
 *   - Shows the latest note inline if one exists
 *
 * "Mark handled" on a cart logs a recovery_email_sent action, which is a
 * terminal action that both:
 *   (a) excludes the cart from the query on next load, and
 *   (b) increments the "Processed today" KPI.
 */

export type CartRow = {
  id: string
  customer_email: string | null
  customer_name: string | null
  total_price: string
  line_item_count: number
  abandoned_at: string // ISO string after serialization
  assigned_rep: string | null
  contacted_at: string | null
}

type Props = {
  initialRows: CartRow[]
  initialNotes: Record<string, string | null>
  initialInProgress: Record<string, boolean>
}

const NOTE_DISPLAY_MAX = 70

export function AbandonedCartsGrid({
  initialRows,
  initialNotes,
  initialInProgress,
}: Props) {
  const router = useRouter()
  const [rows, setRows] = useState(initialRows)
  const [notesByCart, setNotesByCart] = useState(initialNotes)
  const [inProgress, setInProgress] = useState(initialInProgress)
  const [openNoteFor, setOpenNoteFor] = useState<string | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())

  useEffect(() => {
    setRows(initialRows)
    setNotesByCart(initialNotes)
    setInProgress(initialInProgress)
  }, [initialRows, initialNotes, initialInProgress])

  function setCartPending(id: string, isPending: boolean) {
    setPending((cur) => {
      const next = new Set(cur)
      if (isPending) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function markHandled(cart: CartRow) {
    const who = cart.customer_email ?? cart.customer_name ?? 'this cart'
    const ok = window.confirm(
      `Mark cart handled?\n\n${who} — ${formatMoney(cart.total_price)}\n\nIt will disappear from the dashboard.`,
    )
    if (!ok) return

    const previousRows = rows
    setRows((cur) => cur.filter((r) => r.id !== cart.id))
    setCartPending(cart.id, true)

    try {
      const res = await fetch('/api/actions/process-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceType: 'abandoned_checkout',
          resourceId: cart.id,
          actionType: 'recovery_email_sent',
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.scError || data.error || 'Failed to mark handled')
      router.refresh()
    } catch (err) {
      setRows(previousRows)
      window.alert(
        `Failed to mark handled: ${err instanceof Error ? err.message : 'unknown error'}`,
      )
    } finally {
      setCartPending(cart.id, false)
    }
  }

  async function saveNote(cart: CartRow, noteText: string) {
    const trimmed = noteText.trim()
    if (!trimmed) return

    const previousNote = notesByCart[cart.id] ?? null
    const previousInProgress = inProgress[cart.id] ?? false

    setNotesByCart((cur) => ({ ...cur, [cart.id]: trimmed }))
    setInProgress((cur) => ({ ...cur, [cart.id]: true }))
    setOpenNoteFor(null)
    setCartPending(cart.id, true)

    try {
      const res = await fetch('/api/actions/process-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceType: 'abandoned_checkout',
          resourceId: cart.id,
          actionType: 'add_note',
          note: trimmed,
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.scError || data.error || 'Failed to save note')
      router.refresh()
    } catch (err) {
      setNotesByCart((cur) => ({ ...cur, [cart.id]: previousNote }))
      setInProgress((cur) => ({ ...cur, [cart.id]: previousInProgress }))
      window.alert(
        `Failed to save note: ${err instanceof Error ? err.message : 'unknown error'}`,
      )
    } finally {
      setCartPending(cart.id, false)
    }
  }

  if (rows.length === 0) {
    return <div className="empty">No high-value abandoned carts in the last 7 days.</div>
  }

  return (
    <div className="cart-grid">
      {rows.map((r) => {
        const isOpen = openNoteFor === r.id
        const isPending = pending.has(r.id)
        const note = notesByCart[r.id] ?? null
        const showInProgress = !note && inProgress[r.id]

        return (
          <div key={r.id} className={`cart-c ${isOpen ? 'cart-c-open' : ''}`}>
            <p className="cart-cu">
              {r.customer_email ?? r.customer_name ?? 'Anonymous cart'}
            </p>
            <p className="cart-m">
              Abandoned {timeAgo(new Date(r.abandoned_at))} · {r.line_item_count} items
            </p>
            <p className="cart-v">{formatMoney(r.total_price)}</p>

            <p className="cart-rep">
              {r.assigned_rep ? (
                <>
                  Assigned: <span className="tag-p auto">{r.assigned_rep}</span>
                </>
              ) : r.contacted_at ? (
                `Contacted ${timeAgo(new Date(r.contacted_at))}`
              ) : (
                'Unassigned'
              )}
            </p>

            {note ? (
              <div className="cart-note" title={note}>
                <span className="cart-note-ic">💬</span>
                <span className="cart-note-text">
                  {note.length > NOTE_DISPLAY_MAX
                    ? `${note.slice(0, NOTE_DISPLAY_MAX).trimEnd()}…`
                    : note}
                </span>
              </div>
            ) : showInProgress ? (
              <div className="cart-status">
                <span className="bdg b-w">In progress</span>
              </div>
            ) : null}

            <div className="cart-a">
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
                title="Mark this cart handled and remove it from the dashboard"
              >
                ✓ Mark handled
              </button>
            </div>

            {isOpen && (
              <CartNoteForm
                cartLabel={`${r.customer_email ?? r.customer_name ?? 'cart'} · ${formatMoney(r.total_price)}`}
                initialNote={note ?? ''}
                onSave={(text) => saveNote(r, text)}
                onCancel={() => setOpenNoteFor(null)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Inline note editor that expands inside the cart card.
 */
function CartNoteForm({
  cartLabel,
  initialNote,
  onSave,
  onCancel,
}: {
  cartLabel: string
  initialNote: string
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initialNote)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
    if (ref.current && initialNote) {
      ref.current.setSelectionRange(initialNote.length, initialNote.length)
    }
  }, [initialNote])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      onSave(text)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="cart-form">
      <div className="cart-form-label">
        Note for <strong>{cartLabel}</strong>
      </div>
      <textarea
        ref={ref}
        className="cart-form-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="What's the situation? (Cmd+Enter to save, Esc to cancel)"
        rows={3}
      />
      <div className="cart-form-buttons">
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

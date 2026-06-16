'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatMoney, timeAgo } from './shared'
import { confirmDialog } from './ConfirmDialog'

/**
 * Client-side grid for abandoned carts. Same pattern as OrdersTable:
 *   - Three buttons per card: ✉ Email + Note + ✓ Mark handled
 *   - Email opens a composer INSIDE the card with a prefilled recovery
 *     email (To / Subject / Body). The rep copies the pieces into a draft
 *     in their own mail client — no sending service involved — then clicks
 *     "✓ Mark emailed" to clear the card.
 *   - Mark handled is one click (+ confirm), removes the card optimistically
 *   - Note opens an inline form INSIDE the card (card grows taller)
 *   - Shows the latest note inline if one exists
 *
 * Both "✓ Mark handled" and the composer's "✓ Mark emailed" log a
 * recovery_email_sent processing_action, which is terminal:
 *   (a) the cart is excluded from the query on next load, and
 *   (b) the "Processed today" KPI goes up by 1.
 */

export type CartLineItem = {
  title: string | null
  quantity: number
}

export type CartRow = {
  id: string
  customer_email: string | null
  customer_name: string | null
  total_price: string
  line_item_count: number
  abandoned_at: string // ISO string after serialization
  assigned_rep: string | null
  contacted_at: string | null
  recovery_url: string | null
  line_items: CartLineItem[]
}

type Props = {
  initialRows: CartRow[]
  initialNotes: Record<string, string | null>
  initialInProgress: Record<string, boolean>
}

const NOTE_DISPLAY_MAX = 70

/* ------------------------------------------------------------------ */
/*  Email template                                                     */
/* ------------------------------------------------------------------ */

function firstNameOf(fullName: string | null): string | null {
  if (!fullName) return null
  const first = fullName.trim().split(/\s+/)[0]
  return first || null
}

/**
 * Turns the cart's line items into a natural phrase:
 *   1 item  -> "the Fox 2.0 Performance Series"
 *   2 items -> "the Fox 2.0 ... and the King 2.5 ..."
 *   3+      -> "the Fox 2.0 ... and 2 other items"
 * Falls back to "{n} items" if titles are missing from the payload.
 */
function summarizeItems(items: CartLineItem[], fallbackCount: number): string {
  const titles = items.map((i) => i.title).filter((t): t is string => !!t)
  if (titles.length === 0) {
    return fallbackCount === 1 ? 'an item' : `${fallbackCount} items`
  }
  if (titles.length === 1) return `the ${titles[0]}`
  if (titles.length === 2) return `the ${titles[0]} and the ${titles[1]}`
  const rest = titles.length - 1
  return `the ${titles[0]} and ${rest} other item${rest === 1 ? '' : 's'}`
}

function buildEmailDraft(cart: CartRow): { subject: string; body: string } {
  const first = firstNameOf(cart.customer_name)
  const items = summarizeItems(cart.line_items ?? [], cart.line_item_count)

  const linkBlock = cart.recovery_url
    ? `Your cart is saved here whenever you're ready to pick back up:\n${cart.recovery_url}\n\n`
    : ''

  const subject = 'Your Shock Surplus cart — any questions?'

  const body =
    `Hi ${first ?? 'there'},\n\n` +
    `I noticed you had ${items} in your cart at Shock Surplus and wanted to ` +
    `reach out personally in case you had any questions about fitment, ` +
    `shipping, or pricing before you finish up.\n\n` +
    linkBlock +
    `If it's easier to talk it through, just reply to this email — happy to help.\n\n` +
    `Thanks,\n` +
    `${cart.assigned_rep ?? '[Your name]'}\n` +
    `Shock Surplus`

  return { subject, body }
}

/* ------------------------------------------------------------------ */
/*  Clipboard helper                                                   */
/* ------------------------------------------------------------------ */

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fallback for older browsers: invisible textarea + execCommand.
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  async function handleCopy() {
    const ok = await copyText(value)
    if (!ok) {
      window.alert('Copy failed — select the text and copy it manually.')
      return
    }
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button type="button" className="btn-sm" onClick={handleCopy}>
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/*  Grid                                                               */
/* ------------------------------------------------------------------ */

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
  const [openEmailFor, setOpenEmailFor] = useState<string | null>(null)
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

  /**
   * Shared by "✓ Mark handled" (after confirm) and the composer's
   * "✓ Mark emailed" (no confirm — opening the composer was deliberate).
   * Logs the terminal recovery_email_sent action and yanks the card.
   */
  async function logHandled(cart: CartRow) {
    const previousRows = rows
    setOpenEmailFor((cur) => (cur === cart.id ? null : cur))
    setOpenNoteFor((cur) => (cur === cart.id ? null : cur))
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

  async function markHandled(cart: CartRow) {
    const who = cart.customer_email ?? cart.customer_name ?? 'this cart'
    const ok = await confirmDialog({
      title: 'Mark cart handled?',
      message:
        `${who} — ${formatMoney(cart.total_price)}\n\n` +
        'It will disappear from the dashboard.',
      confirmLabel: '✓ Mark handled',
    })
    if (!ok) return
    await logHandled(cart)
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
        const isNoteOpen = openNoteFor === r.id
        const isEmailOpen = openEmailFor === r.id
        const isOpen = isNoteOpen || isEmailOpen
        const isPending = pending.has(r.id)
        const note = notesByCart[r.id] ?? null
        const showInProgress = !note && inProgress[r.id]
        const hasEmail = !!r.customer_email

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
                onClick={() => {
                  setOpenEmailFor(isEmailOpen ? null : r.id)
                  setOpenNoteFor(null)
                }}
                disabled={isPending || !hasEmail}
                title={
                  hasEmail
                    ? 'Open a prefilled recovery email to copy into your mail client'
                    : 'No email address on this cart'
                }
              >
                ✉ Email
              </button>
              <button
                type="button"
                className="btn-row-note"
                onClick={() => {
                  setOpenNoteFor(isNoteOpen ? null : r.id)
                  setOpenEmailFor(null)
                }}
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

            {isNoteOpen && (
              <CartNoteForm
                cartLabel={`${r.customer_email ?? r.customer_name ?? 'cart'} · ${formatMoney(r.total_price)}`}
                initialNote={note ?? ''}
                onSave={(text) => saveNote(r, text)}
                onCancel={() => setOpenNoteFor(null)}
              />
            )}

            {isEmailOpen && (
              <CartEmailForm
                cart={r}
                cartLabel={`${r.customer_email ?? r.customer_name ?? 'cart'} · ${formatMoney(r.total_price)}`}
                onMarkEmailed={() => logHandled(r)}
                onClose={() => setOpenEmailFor(null)}
                disabled={isPending}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Inline recovery-email composer                                     */
/* ------------------------------------------------------------------ */

/**
 * Expands inside the cart card with a prefilled To / Subject / Body.
 * Subject and body are editable before copying. Each field has its own
 * Copy button; "Open draft in" links prefill a draft in the rep's mail
 * app or Gmail as a shortcut. "✓ Mark emailed" logs the same terminal
 * action as Mark handled and clears the card.
 */
function CartEmailForm({
  cart,
  cartLabel,
  onMarkEmailed,
  onClose,
  disabled,
}: {
  cart: CartRow
  cartLabel: string
  onMarkEmailed: () => void
  onClose: () => void
  disabled: boolean
}) {
  // Computed once on open; the rep edits from there.
  const [draft] = useState(() => buildEmailDraft(cart))
  const [subject, setSubject] = useState(draft.subject)
  const [body, setBody] = useState(draft.body)

  const to = cart.customer_email ?? ''

  // mailto wants CRLF line breaks; Gmail's compose URL is fine with \n.
  const mailtoHref =
    `mailto:${to}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body.replace(/\n/g, '\r\n'))}`

  const gmailHref =
    'https://mail.google.com/mail/?view=cm&fs=1' +
    `&to=${encodeURIComponent(to)}` +
    `&su=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="cart-form cart-email-form" onKeyDown={handleKeyDown}>
      <div className="cart-form-label">
        Recovery email for <strong>{cartLabel}</strong>
      </div>

      <div className="email-field">
        <span className="email-field-name">To</span>
        <input className="email-input" value={to} readOnly />
        <CopyButton value={to} />
      </div>

      <div className="email-field">
        <span className="email-field-name">Subject</span>
        <input
          className="email-input"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <CopyButton value={subject} />
      </div>

      <div className="email-body-head">
        <span className="email-field-name">Body</span>
        <CopyButton value={body} />
      </div>
      <textarea
        className="email-input email-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={11}
      />

      {!cart.recovery_url && (
        <div className="email-warn">
          No recovery link found on this cart, so the “your cart is saved here”
          line was left out.
        </div>
      )}

      <div className="cart-form-buttons email-form-buttons">
        <span className="email-open-links">
          Open draft in:{' '}
          <a href={mailtoHref} title="Opens your default mail app with this draft prefilled">
            mail app
          </a>{' '}
          ·{' '}
          <a
            href={gmailHref}
            target="_blank"
            rel="noreferrer"
            title="Opens a prefilled Gmail compose window in a new tab"
          >
            Gmail
          </a>
        </span>
        <button
          type="button"
          className="btn-sm btn-primary"
          onClick={onMarkEmailed}
          disabled={disabled}
          title="Log the email as sent and remove this cart from the dashboard"
        >
          ✓ Mark emailed
        </button>
        <button type="button" className="btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Inline note editor (unchanged)                                     */
/* ------------------------------------------------------------------ */

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

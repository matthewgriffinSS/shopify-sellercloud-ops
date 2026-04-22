'use client'

import { useEffect, useState } from 'react'

/**
 * Custom confirm dialog that replaces window.confirm().
 *
 * Why this exists: window.confirm() can be permanently suppressed by Chrome's
 * "Prevent this page from creating additional dialogs" checkbox. Once a user
 * ticks it (often by accident), every subsequent confirm() returns false
 * silently and every destructive action becomes impossible until the user
 * closes and reopens the tab. Some users never figure out what happened.
 *
 * This dialog is rendered by React inside the page, so the browser has no
 * way to suppress it. Same imperative API as window.confirm() — one call
 * from anywhere, returns a Promise<boolean>.
 *
 *   if (await confirmDialog({ title: 'Delete?', message: 'Gone forever.' })) { ... }
 *
 * <ConfirmDialogRoot /> must be mounted once, at the root of the app
 * (see app/layout.tsx). Multiple mounts will all show the same dialog
 * at the same time — don't do that.
 */

type ConfirmOptions = {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean // styles the confirm button red
}

type InternalRequest = ConfirmOptions & {
  resolve: (value: boolean) => void
}

// Module-level state + subscriber pattern. Works because there's only ever
// one ConfirmDialogRoot in the tree and one active request at a time.
let current: InternalRequest | null = null
let notify: (() => void) | null = null

/**
 * Imperative API. Call from anywhere — including async event handlers,
 * outside of React render. Returns true if the user confirmed, false if
 * they cancelled or closed the dialog.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  // If a dialog is already open, reject its request and replace. Prevents
  // stacking dialogs if the user spam-clicks.
  if (current) {
    current.resolve(false)
    current = null
  }

  return new Promise<boolean>((resolve) => {
    current = { ...options, resolve }
    notify?.()
  })
}

/**
 * Mount exactly once at the app root.
 */
export function ConfirmDialogRoot() {
  const [, setTick] = useState(0)

  useEffect(() => {
    notify = () => setTick((t) => t + 1)
    return () => {
      notify = null
    }
  }, [])

  // Close on Escape, confirm on Enter. Only active when a dialog is showing.
  useEffect(() => {
    if (!current) return
    function onKey(e: KeyboardEvent) {
      if (!current) return
      if (e.key === 'Escape') {
        e.preventDefault()
        handleCancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handleConfirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function handleConfirm() {
    const req = current
    current = null
    setTick((t) => t + 1)
    req?.resolve(true)
  }

  function handleCancel() {
    const req = current
    current = null
    setTick((t) => t + 1)
    req?.resolve(false)
  }

  if (!current) return null

  const {
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
  } = current

  return (
    <div className="cd-overlay" onClick={handleCancel}>
      <div
        className="cd-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="cd-title" className="cd-title">
          {title}
        </h3>
        <p className="cd-message">{message}</p>
        <div className="cd-actions">
          <button type="button" className="btn" onClick={handleCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={destructive ? 'btn cd-btn-destructive' : 'btn btn-primary'}
            onClick={handleConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

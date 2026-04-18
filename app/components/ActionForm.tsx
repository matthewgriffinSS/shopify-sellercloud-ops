'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

type ActionType =
  | 'mark_fulfilled'
  | 'add_note'
  | 'escalate'
  | 'release_hold'
  | 'mark_processed'
  | 'contacted'
  | 'recovery_email_sent'

type Props = {
  resourceType: 'order' | 'draft_order' | 'abandoned_checkout'
  resourceId: string
  resourceLabel: string
  actions: Array<{ value: ActionType; label: string }>
  onClose?: () => void
}

/**
 * Inline action form. Shows a dropdown of action types, optional fields,
 * and posts to /api/actions/process-order on submit.
 */
export function ActionForm({ resourceType, resourceId, resourceLabel, actions, onClose }: Props) {
  const router = useRouter()
  const [actionType, setActionType] = useState<ActionType>(actions[0].value)
  const [note, setNote] = useState('')
  const [trackingCarrier, setTrackingCarrier] = useState('UPS')
  const [trackingNumber, setTrackingNumber] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const needsTracking = actionType === 'mark_fulfilled'

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/actions/process-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceType,
          resourceId,
          actionType,
          note: note || undefined,
          tracking: needsTracking
            ? { carrier: trackingCarrier, number: trackingNumber }
            : undefined,
        }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.scError || data.error || 'Failed to submit')
        setSubmitting(false)
        return
      }
      router.refresh()
      onClose?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit')
      setSubmitting(false)
    }
  }

  return (
    <div className="act-form">
      <div className="act-row">
        <label>Target</label>
        <span style={{ fontWeight: 500 }}>{resourceLabel}</span>
      </div>
      <div className="act-row">
        <label>Action</label>
        <select value={actionType} onChange={(e) => setActionType(e.target.value as ActionType)}>
          {actions.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      {needsTracking && (
        <>
          <div className="act-row">
            <label>Carrier</label>
            <select value={trackingCarrier} onChange={(e) => setTrackingCarrier(e.target.value)}>
              <option>UPS</option>
              <option>FedEx</option>
              <option>USPS</option>
              <option>DHL</option>
              <option>Other</option>
            </select>
          </div>
          <div className="act-row">
            <label>Tracking #</label>
            <input
              type="text"
              value={trackingNumber}
              onChange={(e) => setTrackingNumber(e.target.value)}
              placeholder="1Z999AA10123456784"
            />
          </div>
        </>
      )}
      <div className="act-row">
        <label>SC note</label>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note that will appear on the Sellercloud order"
        />
      </div>
      <div className="act-row">
        <button className="btn-sm btn-primary" onClick={submit} disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit to SC ↗'}
        </button>
        {onClose && (
          <button className="btn-sm" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
        )}
      </div>
      {error && (
        <div className="act-ctx" style={{ color: 'var(--danger-text)' }}>
          {error}
        </div>
      )}
      <div className="act-ctx">
        Posts a note on the linked Sellercloud order and records the action in this dashboard.
      </div>
    </div>
  )
}

type RowProps = { resourceType: Props['resourceType']; resourceId: string; resourceLabel: string; actions: Props['actions'] }

/**
 * Convenience wrapper: renders a "Process ↓" button that expands into the form.
 */
export function ActionDropdown(props: RowProps) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button className="btn-sm" onClick={() => setOpen(true)}>
        Process ↓
      </button>
    )
  }
  return <ActionForm {...props} onClose={() => setOpen(false)} />
}

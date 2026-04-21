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

type ResourceType = 'order' | 'draft_order' | 'abandoned_checkout'

type Props = {
  resourceType: ResourceType
  resourceId: string
  resourceLabel: string
  actions: Array<{ value: ActionType; label: string }>
  onClose?: () => void
}

/**
 * Inline action form. Shows a dropdown of action types, optional fields,
 * and posts to /api/actions/process-order on submit.
 *
 * Only `order` resources have a Sellercloud counterpart — draft orders and
 * abandoned carts live in Shopify only until they convert. The UI text
 * below branches on resourceType so we don't promise SC integration for
 * carts/drafts (matching the backend, which already skips SC for those).
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

  // Carts and drafts: no Sellercloud involved, so neutral labels.
  // Orders: keep SC language since the note actually lands in Sellercloud.
  const hasSellercloud = resourceType === 'order'
  const noteLabel = hasSellercloud ? 'SC note' : 'Note'
  const notePlaceholder = hasSellercloud
    ? 'Optional note that will appear on the Sellercloud order'
    : 'Optional note (logged in the dashboard only)'
  const submitLabel = hasSellercloud ? 'Submit to SC ↗' : 'Save'
  const contextText = hasSellercloud
    ? 'Posts a note on the linked Sellercloud order and records the action in this dashboard.'
    : resourceType === 'draft_order'
      ? 'Records the action in this dashboard. Drafts only exist in Shopify — nothing is posted elsewhere.'
      : 'Records the action in this dashboard. Abandoned carts only exist in Shopify until a customer completes checkout — nothing is posted to Sellercloud.'

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
        <label>{noteLabel}</label>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={notePlaceholder}
        />
      </div>
      <div className="act-row">
        <button className="btn-sm btn-primary" onClick={submit} disabled={submitting}>
          {submitting ? 'Submitting…' : submitLabel}
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
      <div className="act-ctx">{contextText}</div>
    </div>
  )
}

type RowProps = {
  resourceType: Props['resourceType']
  resourceId: string
  resourceLabel: string
  actions: Props['actions']
}

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

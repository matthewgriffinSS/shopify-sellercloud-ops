import { NextRequest } from 'next/server'
import { z } from 'zod'
import { sql } from '@/lib/db'
import {
  addOrderNote,
  createShipment,
  findScOrderByShopifyId,
} from '@/lib/sellercloud'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ActionSchema = z.object({
  resourceType: z.enum(['order', 'draft_order', 'abandoned_checkout']),
  resourceId: z.string(),
  actionType: z.enum([
    'mark_fulfilled',
    'add_note',
    'escalate',
    'release_hold',
    'mark_processed',
    'contacted',
    'recovery_email_sent',
  ]),
  actor: z.string().optional(),
  note: z.string().optional(),
  tracking: z.object({ carrier: z.string(), number: z.string() }).optional(),
})

/**
 * Called by the dashboard's action form / row buttons. Does three things:
 *   1. (Best-effort) posts the note / shipment to Sellercloud IF the order
 *      has a SC link cached. Missing SC link is NOT an error — most orders
 *      don't have one and that's fine; the action is logged locally.
 *   2. Records the action in processing_actions (this is what drives the
 *      "Processed" status on the dashboard, and the inline note display).
 *   3. Returns ok/scError.
 *
 * scError is now only set when an SC call was actually attempted and failed,
 * not when SC simply doesn't have the order. That way, hitting "Save note"
 * on a freshly-imported order without an SC link no longer surfaces a
 * confusing "No Sellercloud order found" error to the rep — it just saves
 * the note locally and returns ok.
 */
export async function POST(req: NextRequest) {
  const body = await req.json()
  const parsed = ActionSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ ok: false, error: parsed.error.flatten() }, { status: 400 })
  }
  const input = parsed.data

  let scNoteId: string | null = null
  let scError: string | null = null

  try {
    if (input.resourceType === 'order') {
      const scOrder = await findScOrderByShopifyId(input.resourceId)
      if (scOrder) {
        // Only attempt SC operations if we have a link.
        if (input.actionType === 'mark_fulfilled' && input.tracking) {
          await createShipment(scOrder.ID, {
            carrier: input.tracking.carrier,
            tracking: input.tracking.number,
            note: input.note,
          })
          scNoteId = `shipment-${scOrder.ID}`
        } else if (input.note) {
          await addOrderNote(scOrder.ID, input.note)
          scNoteId = `note-${scOrder.ID}`
        }
      }
      // No SC link = no SC operation = no error. Local logging happens regardless.
    }
  } catch (err) {
    scError = err instanceof Error ? err.message : String(err)
  }

  await sql`
    INSERT INTO processing_actions (
      resource_type, resource_id, action_type, actor, payload,
      sellercloud_note_id, sellercloud_error
    ) VALUES (
      ${input.resourceType}, ${input.resourceId}, ${input.actionType},
      ${input.actor ?? null}, ${sql.json({ note: input.note, tracking: input.tracking })},
      ${scNoteId}, ${scError}
    )
  `

  // Also update side-tables where appropriate.
  if (input.resourceType === 'abandoned_checkout' && input.actionType === 'contacted') {
    await sql`
      UPDATE abandoned_checkouts SET contacted_at = NOW()
      WHERE id = ${input.resourceId}::bigint
    `
  }

  return Response.json({ ok: !scError, scNoteId, scError })
}

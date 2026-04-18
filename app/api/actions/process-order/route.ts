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
 * Called by the dashboard's action form. Does three things:
 *   1. Posts the note / shipment / status change to Sellercloud
 *   2. Records the action in processing_actions (this is what drives
 *      the "Processed" status on the dashboard)
 *   3. Returns ok/error to the client
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
    // Orders have a SC counterpart we can post to. Draft orders and
    // abandoned checkouts do not yet — those actions are log-only.
    if (input.resourceType === 'order') {
      const scOrder = await findScOrderByShopifyId(input.resourceId)
      if (!scOrder) {
        scError = `No Sellercloud order found for Shopify ID ${input.resourceId}`
      } else if (input.actionType === 'mark_fulfilled' && input.tracking) {
        const shipment = await createShipment(scOrder.ID, {
          carrier: input.tracking.carrier,
          tracking: input.tracking.number,
          note: input.note,
        })
        scNoteId = shipment.ID
      } else if (input.note) {
        const note = await addOrderNote(scOrder.ID, input.note, input.actor)
        scNoteId = note.ID
      }
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
      WHERE id = ${BigInt(input.resourceId)}
    `
  }

  return Response.json({ ok: !scError, scNoteId, scError })
}

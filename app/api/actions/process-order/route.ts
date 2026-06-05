import { NextRequest } from 'next/server'
import { z } from 'zod'
import { sql } from '@/lib/db'

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
 * Called by the dashboard's action form / row buttons. Records the action in
 * processing_actions (this is what drives the "Processed" status on the
 * dashboard and the inline note display) and updates side-tables where
 * appropriate.
 *
 * Sellercloud has been fully removed (the business moved to Sage 500, no API
 * access), so every action is now a purely local status change — no external
 * system is contacted. The sellercloud_note_id / sellercloud_error columns have
 * been dropped from processing_actions, so they are no longer part of the INSERT.
 */
export async function POST(req: NextRequest) {
  const body = await req.json()
  const parsed = ActionSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ ok: false, error: parsed.error.flatten() }, { status: 400 })
  }
  const input = parsed.data

  await sql`
    INSERT INTO processing_actions (
      resource_type, resource_id, action_type, actor, payload
    ) VALUES (
      ${input.resourceType}, ${input.resourceId}, ${input.actionType},
      ${input.actor ?? null}, ${sql.json({ note: input.note, tracking: input.tracking })}
    )
  `

  // Side-table updates.
  if (input.resourceType === 'abandoned_checkout' && input.actionType === 'contacted') {
    await sql`
      UPDATE abandoned_checkouts SET contacted_at = NOW()
      WHERE id = ${input.resourceId}::bigint
    `
  }

  return Response.json({ ok: true })
}

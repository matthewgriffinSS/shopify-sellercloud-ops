import { NextRequest } from 'next/server'
import { z } from 'zod'
import { sql } from '@/lib/db'
import { verifyCookieValue } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * PATCH /api/actions/draft-followup
 *
 * Updates a single follow-up field on a draft order. Called whenever a rep
 * toggles a checkbox or edits a note/link/richpanel field on their page.
 *
 * Dates (sms_date, phone_call_date, converted_at) auto-stamp to NOW() when
 * their matching checkbox transitions from false to true, and clear when
 * unchecked. The client never sends dates — the server owns them.
 */

// The only fields the rep can change. Anything else is webhook-owned.
const FIELDS = [
  'followed_up',
  'email_followup',
  'sms_followup',
  'phone_followup',
  'converted',
  'richpanel_link',
  'rep_notes',
  'can_delete',
] as const
type Field = (typeof FIELDS)[number]

const Schema = z.object({
  id: z.string(),
  field: z.enum(FIELDS),
  value: z.union([z.boolean(), z.string(), z.null()]),
})

export async function POST(req: NextRequest) {
  const cookieValue = req.cookies.get('dashboard_auth')?.value
  if (process.env.DASHBOARD_PASSWORD && !verifyCookieValue(cookieValue)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const body = await req.json()
  const parsed = Schema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ ok: false, error: parsed.error.flatten() }, { status: 400 })
  }
  const { id, field, value } = parsed.data

  try {
    await updateField(id, field, value)
    return Response.json({ ok: true })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

async function updateField(id: string, field: Field, value: boolean | string | null) {
  const idBigint = `${id}::bigint`

  // Text fields — trim and store, null out if empty.
  if (field === 'richpanel_link' || field === 'rep_notes') {
    const text = typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
    if (field === 'richpanel_link') {
      await sql`UPDATE shopify_draft_orders SET richpanel_link = ${text}, updated_at = NOW() WHERE id = ${id}::bigint`
    } else {
      await sql`UPDATE shopify_draft_orders SET rep_notes = ${text}, updated_at = NOW() WHERE id = ${id}::bigint`
    }
    return
  }

  // Boolean fields — coerce from whatever the client sent.
  const bool = value === true || value === 'true' || value === 1

  // Date-stamping checkboxes: stamp NOW() when going true, clear when going false.
  if (field === 'sms_followup') {
    await sql`
      UPDATE shopify_draft_orders
      SET sms_followup = ${bool},
          sms_date = CASE WHEN ${bool} THEN COALESCE(sms_date, NOW()) ELSE NULL END,
          updated_at = NOW()
      WHERE id = ${id}::bigint
    `
    return
  }
  if (field === 'phone_followup') {
    await sql`
      UPDATE shopify_draft_orders
      SET phone_followup = ${bool},
          phone_call_date = CASE WHEN ${bool} THEN COALESCE(phone_call_date, NOW()) ELSE NULL END,
          updated_at = NOW()
      WHERE id = ${id}::bigint
    `
    return
  }
  if (field === 'converted') {
    // Manual toggle — complements the auto-stamp the webhook does when a
    // draft converts into a real order. Useful when a rep closes the deal
    // off-Shopify (phone sale, counter sale, etc).
    await sql`
      UPDATE shopify_draft_orders
      SET converted_at = CASE WHEN ${bool} THEN COALESCE(converted_at, NOW()) ELSE NULL END,
          updated_at = NOW()
      WHERE id = ${id}::bigint
    `
    return
  }

  // Plain boolean columns.
  if (field === 'followed_up') {
    await sql`UPDATE shopify_draft_orders SET followed_up = ${bool}, updated_at = NOW() WHERE id = ${id}::bigint`
    return
  }
  if (field === 'email_followup') {
    await sql`UPDATE shopify_draft_orders SET email_followup = ${bool}, updated_at = NOW() WHERE id = ${id}::bigint`
    return
  }
  if (field === 'can_delete') {
    await sql`UPDATE shopify_draft_orders SET can_delete = ${bool}, updated_at = NOW() WHERE id = ${id}::bigint`
    return
  }

  // Exhaustiveness: should never hit.
  void idBigint
  throw new Error(`Unknown field: ${field}`)
}

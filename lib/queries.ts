// Shared data queries used by the dashboard server components.
// Keeping them here means there's one obvious place to tune performance.

import { sql } from './db'

export type ProcessingStatus = 'needs_action' | 'in_progress' | 'processed'

/**
 * Look up the most recent action for a given resource to determine its
 * processing status.
 */
export async function statusMapForResources(
  resourceType: 'order' | 'draft_order' | 'abandoned_checkout',
  resourceIds: string[],
): Promise<Map<string, { status: ProcessingStatus; actionType: string; at: Date } | null>> {
  const map = new Map<string, { status: ProcessingStatus; actionType: string; at: Date } | null>()
  if (resourceIds.length === 0) return map

  const rows = await sql<
    { resource_id: string; action_type: string; created_at: Date }[]
  >`
    SELECT DISTINCT ON (resource_id) resource_id, action_type, created_at
    FROM processing_actions
    WHERE resource_type = ${resourceType}
      AND resource_id = ANY(${resourceIds})
      AND sellercloud_error IS NULL
    ORDER BY resource_id, created_at DESC
  `

  for (const id of resourceIds) map.set(id, null)
  for (const row of rows) {
    const terminal = ['mark_fulfilled', 'mark_processed', 'recovery_email_sent'].includes(
      row.action_type,
    )
    map.set(row.resource_id, {
      status: terminal ? 'processed' : 'in_progress',
      actionType: row.action_type,
      at: row.created_at,
    })
  }
  return map
}

/**
 * Late fulfillments list. Excludes orders that have already been handled
 * (processing_actions has a terminal action like mark_processed or
 * mark_fulfilled for them). That means clicking "Mark handled" on an order
 * in either the Late or VIP table removes it from BOTH tables on the next
 * page load — the filter is order-scoped, not table-scoped.
 */
export async function fetchLateFulfillments() {
  return sql<
    {
      id: string
      order_number: string
      customer_name: string | null
      total_price: string
      assigned_rep: string | null
      service_type: string | null
      shopify_created_at: Date
      tags: string[]
      sellercloud_order_id: string | null
    }[]
  >`
    SELECT o.id::text, o.order_number, o.customer_name, o.total_price::text,
           o.assigned_rep, o.service_type, o.shopify_created_at, o.tags,
           o.sellercloud_order_id::text
    FROM shopify_orders o
    WHERE (o.fulfillment_status IS NULL OR o.fulfillment_status != 'fulfilled')
      AND o.shopify_created_at < NOW() - INTERVAL '3 days'
      AND NOT EXISTS (
        SELECT 1 FROM processing_actions pa
        WHERE pa.resource_type = 'order'
          AND pa.resource_id = o.id::text
          AND pa.sellercloud_error IS NULL
          AND pa.action_type IN ('mark_processed', 'mark_fulfilled', 'recovery_email_sent')
      )
    ORDER BY o.shopify_created_at ASC
    LIMIT 50
  `
}

/**
 * VIP orders from the last 7 days. Same handled-exclusion logic as
 * fetchLateFulfillments, so "Mark handled" clears an order from both views
 * consistently.
 */
export async function fetchVipOrders() {
  return sql<
    {
      id: string
      order_number: string
      customer_name: string | null
      total_price: string
      assigned_rep: string | null
      service_type: string | null
      shopify_created_at: Date
      fulfillment_status: string | null
      tags: string[]
      sellercloud_order_id: string | null
    }[]
  >`
    SELECT o.id::text, o.order_number, o.customer_name, o.total_price::text,
           o.assigned_rep, o.service_type, o.shopify_created_at, o.fulfillment_status, o.tags,
           o.sellercloud_order_id::text
    FROM shopify_orders o
    WHERE o.is_vip = TRUE
      AND o.shopify_created_at > NOW() - INTERVAL '7 days'
      AND NOT EXISTS (
        SELECT 1 FROM processing_actions pa
        WHERE pa.resource_type = 'order'
          AND pa.resource_id = o.id::text
          AND pa.sellercloud_error IS NULL
          AND pa.action_type IN ('mark_processed', 'mark_fulfilled', 'recovery_email_sent')
      )
    ORDER BY o.shopify_created_at DESC
    LIMIT 50
  `
}

/**
 * Per-rep summary tiles for the /sales page.
 */
export type DraftFollowupRow = {
  id: string
  name: string
  customer_name: string | null
  customer_email: string | null
  customer_phone: string | null
  total_price: string
  status: string | null
  tags: string[]
  assigned_rep: string | null
  service_type: string | null
  converted_order_id: string | null
  followed_up: boolean
  email_followup: boolean
  sms_followup: boolean
  sms_date: Date | null
  phone_followup: boolean
  phone_call_date: Date | null
  converted_at: Date | null
  richpanel_link: string | null
  rep_notes: string | null
  can_delete: boolean
  shopify_created_at: Date
}

export async function fetchDraftsForRep(rep: string): Promise<DraftFollowupRow[]> {
  const repFilter = rep === 'unassigned' ? null : rep
  return sql<DraftFollowupRow[]>`
    SELECT
      id::text,
      name,
      customer_name,
      customer_email,
      customer_phone,
      total_price::text,
      status,
      tags,
      assigned_rep,
      service_type,
      converted_order_id::text,
      followed_up,
      email_followup,
      sms_followup,
      sms_date,
      phone_followup,
      phone_call_date,
      converted_at,
      richpanel_link,
      rep_notes,
      can_delete,
      shopify_created_at
    FROM shopify_draft_orders d
    WHERE status = 'invoice_sent'
      AND shopify_created_at > NOW() - INTERVAL '30 days'
      AND service_type IS NULL
      AND can_delete = FALSE
      AND converted_order_id IS NULL
      AND converted_at IS NULL
      AND (
        (${repFilter}::text IS NULL AND assigned_rep IS NULL)
        OR assigned_rep = ${repFilter}
      )
      AND NOT EXISTS (
        SELECT 1 FROM shopify_draft_orders sib
        WHERE sib.id != d.id
          AND sib.converted_at IS NOT NULL
          AND sib.converted_at > NOW() - INTERVAL '30 days'
          AND (
            (sib.customer_email IS NOT NULL
             AND d.customer_email IS NOT NULL
             AND LOWER(sib.customer_email) = LOWER(d.customer_email))
            OR
            (sib.customer_phone IS NOT NULL
             AND d.customer_phone IS NOT NULL
             AND LENGTH(regexp_replace(sib.customer_phone, '\D', '', 'g')) >= 10
             AND RIGHT(regexp_replace(sib.customer_phone, '\D', '', 'g'), 10) =
                 RIGHT(regexp_replace(d.customer_phone, '\D', '', 'g'), 10))
          )
      )
    ORDER BY shopify_created_at ASC
    LIMIT 500
  `
}

export async function fetchAbandonedCarts() {
  return sql<
    {
      id: string
      customer_email: string | null
      customer_name: string | null
      total_price: string
      line_item_count: number
      abandoned_at: Date
      assigned_rep: string | null
      contacted_at: Date | null
    }[]
  >`
    SELECT id::text, customer_email, customer_name, total_price::text,
           line_item_count, abandoned_at, assigned_rep, contacted_at
    FROM abandoned_checkouts
    WHERE abandoned_at > NOW() - INTERVAL '7 days'
      AND recovered_at IS NULL
    ORDER BY abandoned_at DESC
    LIMIT 12
  `
}

export async function fetchMetrics() {
  const [late] = await sql<{ revenue: string; count: string }[]>`
    SELECT COALESCE(SUM(o.total_price), 0)::text AS revenue, COUNT(*)::text AS count
    FROM shopify_orders o
    WHERE (o.fulfillment_status IS NULL OR o.fulfillment_status != 'fulfilled')
      AND o.shopify_created_at < NOW() - INTERVAL '3 days'
      AND NOT EXISTS (
        SELECT 1 FROM processing_actions pa
        WHERE pa.resource_type = 'order'
          AND pa.resource_id = o.id::text
          AND pa.sellercloud_error IS NULL
          AND pa.action_type IN ('mark_processed', 'mark_fulfilled', 'recovery_email_sent')
      )
  `

  const [abandoned] = await sql<{ revenue: string; count: string }[]>`
    SELECT COALESCE(SUM(total_price), 0)::text AS revenue, COUNT(*)::text AS count
    FROM abandoned_checkouts
    WHERE abandoned_at > NOW() - INTERVAL '7 days'
      AND recovered_at IS NULL
  `

  const [processedToday] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM processing_actions
    WHERE created_at::date = CURRENT_DATE
      AND action_type IN ('mark_fulfilled', 'mark_processed', 'recovery_email_sent')
      AND sellercloud_error IS NULL
  `

  const [vipMtd] = await sql<{ revenue: string; count: string }[]>`
    SELECT COALESCE(SUM(total_price), 0)::text AS revenue, COUNT(*)::text AS count
    FROM shopify_orders
    WHERE is_vip = TRUE
      AND shopify_created_at >= date_trunc('month', NOW())
  `

  const [avgResolve] = await sql<{ avg_hours: string | null }[]>`
    SELECT EXTRACT(EPOCH FROM AVG(pa.created_at - o.shopify_created_at)) / 3600 AS avg_hours
    FROM processing_actions pa
    JOIN shopify_orders o ON o.id::text = pa.resource_id
    WHERE pa.action_type IN ('mark_fulfilled', 'mark_processed')
      AND pa.created_at > NOW() - INTERVAL '7 days'
      AND pa.sellercloud_error IS NULL
  `

  return {
    revenueAtRisk: parseFloat(late.revenue) + parseFloat(abandoned.revenue),
    awaitingAction: parseInt(late.count) + parseInt(abandoned.count),
    processedToday: parseInt(processedToday.count),
    avgResolveHours: avgResolve.avg_hours ? parseFloat(avgResolve.avg_hours) : null,
    vipRevenueMtd: parseFloat(vipMtd.revenue),
    vipOrderCountMtd: parseInt(vipMtd.count),
  }
}

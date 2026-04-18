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
    }[]
  >`
    SELECT id::text, order_number, customer_name, total_price::text,
           assigned_rep, service_type, shopify_created_at, tags
    FROM shopify_orders
    WHERE (fulfillment_status IS NULL OR fulfillment_status != 'fulfilled')
      AND shopify_created_at < NOW() - INTERVAL '3 days'
    ORDER BY shopify_created_at ASC
    LIMIT 50
  `
}

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
    }[]
  >`
    SELECT id::text, order_number, customer_name, total_price::text,
           assigned_rep, service_type, shopify_created_at, fulfillment_status, tags
    FROM shopify_orders
    WHERE is_vip = TRUE
      AND shopify_created_at > NOW() - INTERVAL '7 days'
    ORDER BY shopify_created_at DESC
    LIMIT 50
  `
}

export async function fetchDraftsByRep() {
  return sql<
    { assigned_rep: string; count: string; total_value: string; stale_count: string }[]
  >`
    SELECT
      COALESCE(assigned_rep, 'unassigned') AS assigned_rep,
      COUNT(*)::text AS count,
      COALESCE(SUM(total_price), 0)::text AS total_value,
      COUNT(*) FILTER (WHERE shopify_created_at < NOW() - INTERVAL '7 days')::text AS stale_count
    FROM shopify_draft_orders
    WHERE status = 'open'
    GROUP BY COALESCE(assigned_rep, 'unassigned')
    ORDER BY SUM(total_price) DESC
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
    SELECT COALESCE(SUM(total_price), 0)::text AS revenue, COUNT(*)::text AS count
    FROM shopify_orders
    WHERE (fulfillment_status IS NULL OR fulfillment_status != 'fulfilled')
      AND shopify_created_at < NOW() - INTERVAL '3 days'
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

/**
 * One-shot local SC ID backfill.
 *
 * The scheduled cron at /api/cron/backfill-sc-ids is capped at 60s (Vercel
 * serverless) so it can only walk ~15 pages / ~3,750 SC orders per run. That
 * handles new orders fine but can't reach the existing backlog, where
 * candidates are up to 90 days old and sitting behind tens of thousands of
 * newer SC orders.
 *
 * This script has no such cap — it walks as long as it takes, logs progress
 * per page, and writes matches straight to Postgres as it finds them. Safe
 * to Ctrl-C at any point; every match is committed before the next page
 * fetch.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill-sc-backlog.ts
 *
 * Env overrides:
 *   MAX_PAGES       default 500  (how deep into SC to walk before giving up)
 *   DAYS_BACK       default 90   (how far back to pull unlinked candidates)
 *   PAGE_PAUSE_MS   default 500  (polite pause between SC pages)
 *   DRY_RUN         default 0    (set to 1 to log matches without writing)
 */

import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { listScOrders, type ScListOrder } from '../lib/sellercloud'
import { sql } from '../lib/db'

const MAX_PAGES = parseInt(process.env.MAX_PAGES ?? '500', 10)
const DAYS_BACK = parseInt(process.env.DAYS_BACK ?? '90', 10)
const PAGE_PAUSE_MS = parseInt(process.env.PAGE_PAUSE_MS ?? '500', 10)
const DRY_RUN = process.env.DRY_RUN === '1'

// --- Matcher (inlined — scItemMatches isn't exported from lib/sellercloud) ---

function scItemShopifyIdentifiers(item: ScListOrder): Set<string> {
  const out = new Set<string>()
  const candidates = [
    item.OrderSourceOrderID,
    item.EBaySellingManagerSalesRecordNumber,
    item.CompletedOrderID,
    item.ChannelOrderID,
    item.ChannelOrderID2,
    item.SecondaryOrderSourceOrderID,
  ]
  for (const v of candidates) {
    if (typeof v === 'string' && v.length > 0) out.add(v)
  }
  return out
}

function scItemMatches(
  item: ScListOrder,
  target: {
    shopifyNumericId: string
    shopifyOrderNumber?: string | null
    shopifyName?: string | null
  },
): boolean {
  const itemIds = scItemShopifyIdentifiers(item)
  const wanted = new Set<string>()
  wanted.add(target.shopifyNumericId)
  if (target.shopifyOrderNumber) wanted.add(target.shopifyOrderNumber)
  if (target.shopifyName) {
    wanted.add(target.shopifyName)
    const stripped = target.shopifyName.replace(/^[A-Za-z]+/, '')
    if (stripped) wanted.add(stripped)
  }
  for (const id of itemIds) {
    if (wanted.has(id)) return true
    const stripped = id.replace(/^[A-Za-z]+/, '')
    if (stripped && wanted.has(stripped)) return true
  }
  return false
}

// --- Main ---

async function fetchPageWithRetry(page: number): Promise<ScListOrder[] | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await listScOrders(page, 250)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  ! page ${page} attempt ${attempt} failed: ${msg}`)
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 3000 * attempt))
      }
    }
  }
  return null
}

async function main() {
  console.log(`SC ID backfill — local one-shot`)
  console.log(`  maxPages:     ${MAX_PAGES}`)
  console.log(`  daysBack:     ${DAYS_BACK}`)
  console.log(`  pagePauseMs:  ${PAGE_PAUSE_MS}`)
  console.log(`  dryRun:       ${DRY_RUN}`)
  console.log('')

  // 1. Load all unlinked shopify orders within the window.
  const candidates = await sql<
    {
      id: string
      order_number: string
      raw_payload: any
      shopify_created_at: Date
    }[]
  >`
    SELECT id::text, order_number, raw_payload, shopify_created_at
    FROM shopify_orders
    WHERE sellercloud_order_id IS NULL
      AND shopify_created_at > NOW() - ${DAYS_BACK} * INTERVAL '1 day'
    ORDER BY shopify_created_at DESC
  `

  if (candidates.length === 0) {
    console.log('No candidates — nothing to do.')
    process.exit(0)
  }

  const pending = new Map<
    string,
    {
      shopifyNumericId: string
      shopifyOrderNumber: string | null
      shopifyName: string | null
    }
  >()
  for (const c of candidates) {
    const shopifyName =
      typeof c.raw_payload?.name === 'string' ? c.raw_payload.name : null
    pending.set(c.id, {
      shopifyNumericId: c.id,
      shopifyOrderNumber: c.order_number,
      shopifyName,
    })
  }
  const startPending = pending.size
  const oldestCandidate = candidates[candidates.length - 1].shopify_created_at
  console.log(
    `Loaded ${startPending} candidates (oldest: ${oldestCandidate.toISOString()})`,
  )
  console.log('')

  // 2. Walk SC newest-first. For each item, try to match against pending.
  let matched = 0
  let pagesScanned = 0
  let stoppedReason = 'page_cap'
  const startedAt = Date.now()

  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await fetchPageWithRetry(page)
    if (items === null) {
      console.log(`Page ${page}: giving up after 3 attempts, skipping`)
      continue
    }
    pagesScanned = page

    if (items.length === 0) {
      stoppedReason = 'empty_page'
      console.log(`Page ${page}: empty — reached end of SC orders.`)
      break
    }

    let matchedThisPage = 0
    for (const item of items) {
      for (const [shopifyKey, target] of pending) {
        if (!scItemMatches(item, target)) continue

        if (!DRY_RUN) {
          try {
            await sql`
              UPDATE shopify_orders
              SET sellercloud_order_id = ${item.ID}, updated_at = NOW()
              WHERE id = ${shopifyKey}::bigint
                AND sellercloud_order_id IS NULL
            `
          } catch (err) {
            console.log(
              `  ! update failed for shopify ${shopifyKey}: ${err instanceof Error ? err.message : err}`,
            )
            continue
          }
        }
        matched += 1
        matchedThisPage += 1
        pending.delete(shopifyKey)
        break // move on to the next SC item
      }
    }

    const pageOldest = items[items.length - 1]?.TimeOfOrder ?? '?'
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    console.log(
      `page ${String(page).padStart(3)} | ` +
        `items ${String(items.length).padStart(3)} | ` +
        `+${String(matchedThisPage).padStart(3)} | ` +
        `total ${String(matched).padStart(4)}/${startPending} | ` +
        `remaining ${String(pending.size).padStart(4)} | ` +
        `oldest=${pageOldest} | ` +
        `${elapsed}s`,
    )

    if (pending.size === 0) {
      stoppedReason = 'all_found'
      console.log(`\nAll candidates matched — stopping.`)
      break
    }

    if (PAGE_PAUSE_MS > 0) {
      await new Promise((r) => setTimeout(r, PAGE_PAUSE_MS))
    }
  }

  // 3. Summary.
  const elapsed = Math.round((Date.now() - startedAt) / 1000)
  console.log('')
  console.log('=== Done ===')
  console.log(`  Stopped reason:    ${stoppedReason}`)
  console.log(`  Pages scanned:     ${pagesScanned}`)
  console.log(`  Orders matched:    ${matched}`)
  console.log(`  Remaining pending: ${pending.size}`)
  console.log(`  Elapsed:           ${elapsed}s (${Math.round(elapsed / 60)}m)`)
  if (DRY_RUN) console.log(`  (DRY_RUN — no DB writes)`)

  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})

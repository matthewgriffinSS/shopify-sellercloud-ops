Trims action options to "Add note" and "Mark handled", and makes
Mark-handled hide the order from BOTH the Late Fulfillments and VIP
Orders tables at once.

Three file changes:

  MODIFIED:
    lib/queries.ts
      fetchLateFulfillments + fetchVipOrders now exclude orders that
      have a terminal processing_action logged (mark_processed,
      mark_fulfilled, or recovery_email_sent). Because both tables
      filter on the SAME processing_actions table, clicking Mark
      handled on an order in either table hides it from both.

    app/components/LateFulfillments.tsx
      Action dropdown trimmed to just Add note + Mark handled. Removed
      mark_fulfilled (required tracking #), escalate, release_hold.

    app/components/VipOrders.tsx
      Same trim — Add note + Mark handled only. Removed escalate.

NOT CHANGED but worth knowing:
  ActionForm.tsx — still supports all 7 action types at the schema
  level. Other components that use it (draft tables, abandoned carts)
  keep working. Only these two callers pass a reduced action list.

  /api/actions/process-order — no change. mark_processed was already
  a valid action type; no server work needed.

AFTER DEPLOY:
  1. Late Fulfillments dropdown shows only Add note + Mark handled.
  2. VIP Orders dropdown shows the same two.
  3. Clicking Mark handled → order disappears from both tables on the
     next page load (Next.js's router.refresh() fires automatically
     after a successful action).
  4. The Metrics strip at top-of-page updates too — the "Revenue at
     risk" and "Awaiting action" counts now exclude handled orders.

ROLLBACK:
  If a rep marks an order handled by mistake, delete its row from
  the processing_actions table in Neon SQL Editor:

    DELETE FROM processing_actions
    WHERE resource_id = '<shopify numeric id>'
      AND action_type = 'mark_processed'
    ORDER BY created_at DESC
    LIMIT 1;

  On next page load the order reappears.

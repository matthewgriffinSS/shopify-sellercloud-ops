UX overhaul — 7 improvements bundled into one drop.

═══════════════════════════════════════════════════════════════════════
 WHAT'S CHANGED (from your perspective)
═══════════════════════════════════════════════════════════════════════

BEFORE:
  - Single "Process ↓" button that opened an ugly form floating to the
    right edge with all-caps labels, an action dropdown, and a "SUBMIT
    TO SC ↗" button (even though we don't post to SC anymore).
  - Marking handled took 4 clicks: Process ↓ → pick "Mark handled" from
    dropdown → Submit to SC ↗ → wait for refresh.
  - Status column showed a generic "In progress" badge — no info about
    what was actually in progress.

AFTER:
  - Two buttons per row: [Note] and [✓ Mark handled].
  - Mark handled is ONE click, with a confirm dialog so misclicks are
    safe. Row disappears instantly (optimistic UI).
  - Note button expands a clean form INSIDE the table as a full-width
    row underneath the order. Textarea, Save button, Cancel button.
    Cmd/Ctrl+Enter saves; Esc cancels.
  - Status column shows the actual note text inline (truncated to 70
    chars, full text on hover) instead of "In progress".
  - Note save is also optimistic — the note shows immediately, with
    rollback on server error.

═══════════════════════════════════════════════════════════════════════
 FILES IN THIS DROP
═══════════════════════════════════════════════════════════════════════

NEW:
  app/components/OrdersTable.tsx
    Shared client component used by both LateFulfillments and VipOrders.
    Owns local state for rows, notes, and which row's note form is open.
    Optimistic UI for both Mark handled and Save note.

MODIFIED:
  app/components/LateFulfillments.tsx
  app/components/VipOrders.tsx
    Now thin server wrappers that fetch data + notes and pass to
    OrdersTable as initial state.

  lib/queries.ts
    Adds recentNotesForResources() — returns the most recent add_note
    action's text per resource. Other queries unchanged.

  app/api/actions/process-order/route.ts
    Tweaked SC error semantics: missing SC link is no longer an error
    when the action is just add_note. The local action is logged either
    way; the response only sets scError when SC was actually called and
    failed.

  vercel.json
    Crons removed — GitHub Actions handles all scheduling. No more
    duplicate daily run.

CSS (apply to existing app/globals.css):
  globals-additions.css
    APPEND its contents to the bottom of app/globals.css, AND
    REMOVE this rule from globals.css:
        tr.done td { opacity: 0.5; }
    (That rule is now dead — handled orders are filtered at the query
    level, so they never render in the first place.)

═══════════════════════════════════════════════════════════════════════
 DEPLOY STEPS
═══════════════════════════════════════════════════════════════════════

  1. Drop the contents of ux-pass/ over your repo root. The new file
     paths match the existing structure exactly.

  2. Append globals-additions.css to your app/globals.css and remove
     the .done rule. (You can also just delete globals-additions.css
     after copying its contents over.)

  3. Commit + push to main. Vercel auto-deploys.

  4. After deploy:
     - Open /support, click Note on any row. The form should expand
       inline underneath the row with a textarea.
     - Type a note, hit Save. Form closes immediately, note appears
       in the Status column.
     - Click Mark handled. Confirm dialog appears. After confirm, the
       row vanishes instantly.
     - Refresh the page. The handled order is gone for real (server
       state matches what you saw locally).

═══════════════════════════════════════════════════════════════════════
 ROLLBACK
═══════════════════════════════════════════════════════════════════════

If a rep marks the wrong order handled:

    DELETE FROM processing_actions
    WHERE resource_id = '<shopify numeric id>'
      AND action_type = 'mark_processed'
    ORDER BY created_at DESC LIMIT 1;

Then refresh the dashboard. The order reappears.

═══════════════════════════════════════════════════════════════════════
 WHAT WASN'T TOUCHED
═══════════════════════════════════════════════════════════════════════

  - ActionForm.tsx still exists and is still used by AbandonedCarts and
    DraftFollowupTable. We didn't change those flows. If you later want
    the same inline-form treatment there, the OrdersTable pattern is a
    template.

  - Sellercloud library code (lib/sellercloud.ts) — unchanged. The
    verified-matching logic from earlier still applies; SC links still
    work when present. We just made notes work cleanly when they aren't.

  - Action types in the Zod schema — kept all 7 even though only 2
    are used. Cheap to keep, lets you re-enable them later without
    schema changes.

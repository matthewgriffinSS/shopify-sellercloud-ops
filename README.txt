Abandoned carts UX — same treatment as LateFulfillments/VipOrders.

═══════════════════════════════════════════════════════════════════════
 WHAT CHANGED
═══════════════════════════════════════════════════════════════════════

BEFORE:
  - Single "Process ↓" button that opened the old ugly floating form
    with 3 action types (recovery email, contacted, add note) and an
    SC-submit button that never actually posted anywhere for carts.

AFTER:
  - Each cart card has two buttons: [Note] and [✓ Mark handled].
  - Mark handled = one click + confirm → card vanishes instantly from
    the grid (optimistic UI).
  - Note button expands a clean form INSIDE the card. Card grows taller
    to accommodate the textarea, Save, and Cancel buttons.
  - Cmd/Ctrl+Enter saves; Esc cancels.
  - If a note has been left, it shows inline on the card (truncated to
    70 chars with full text on hover) instead of a bare "In progress"
    badge.
  - Open cards get a subtle orange glow so the active one is obvious
    in a busy grid.

═══════════════════════════════════════════════════════════════════════
 WHAT "MARK HANDLED" MEANS FOR A CART
═══════════════════════════════════════════════════════════════════════

Logs a `recovery_email_sent` processing_action, which is treated as
terminal. That means:

  1. The cart disappears from the grid on next refresh (query excludes
     carts with a terminal action).
  2. The "Processed today" KPI goes up by 1.
  3. If the cart later converts (customer completes checkout),
     orders-create sets recovered_at and the cart would also be hidden
     by the original recovery filter — no conflict either way.

A cart can be un-handled by deleting the processing_actions row, same
as orders:

  DELETE FROM processing_actions
  WHERE resource_id = '<cart id>'
    AND action_type = 'recovery_email_sent'
  ORDER BY created_at DESC LIMIT 1;

═══════════════════════════════════════════════════════════════════════
 FILES IN THIS DROP
═══════════════════════════════════════════════════════════════════════

NEW:
  app/components/AbandonedCartsGrid.tsx
    Client component, cart-grid version of OrdersTable's logic. Owns
    optimistic state for rows, notes, and open form.

MODIFIED:
  app/components/AbandonedCarts.tsx
    Now a thin server wrapper — fetches carts + notes and passes them
    to AbandonedCartsGrid as initial state.

  lib/queries.ts
    fetchAbandonedCarts now excludes carts with a terminal
    processing_action. fetchMetrics updated to match (so the
    "Revenue at risk" and "Awaiting action" KPIs stay in sync with
    what's actually shown on the page).

CSS:
  globals-additions.css
    APPEND its contents to app/globals.css. No rules to remove this
    time — everything's additive.

═══════════════════════════════════════════════════════════════════════
 DEPLOY STEPS
═══════════════════════════════════════════════════════════════════════

  1. Drop carts-pass/ contents over your repo root. Paths match existing
     structure.

  2. Append globals-additions.css to the bottom of app/globals.css.

  3. Commit + push.

  4. After deploy, open /sales and scroll to abandoned carts:
     - Each card now has Note and ✓ Mark handled buttons at the bottom.
     - Click Note → form expands inside the card.
     - Type + save → note appears at the top of the card immediately.
     - Click ✓ Mark handled on a different cart → confirm → card
       vanishes from the grid.
     - Refresh page — handled cart stays gone (server state matches).

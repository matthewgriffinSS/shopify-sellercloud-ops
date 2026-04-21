Drop the `changes/` contents directly over your repo root.

MODIFIED (7):
  vercel.json                                                   reverted to daily — GH Actions now drives higher-frequency crons
  lib/sellercloud.ts                                            adds targeted helpers
  app/health/page.tsx                                           better fetch errors + carts button
  app/api/webhooks/shopify/orders-create/route.ts               token-based cart recovery
  app/api/webhooks/shopify/orders-updated/route.ts              customer_name bug fix
  app/api/webhooks/shopify/checkouts-abandoned/route.ts         UNDEFINED_VALUE fix
  app/api/admin/backfill-sc-ids/route.ts                        targeted lookup + 50s budget

NEW (4):
  app/api/admin/backfill-abandoned-carts/route.ts               manual carts backfill
  app/api/cron/poll-abandoned-carts/route.ts                    scheduled carts poll
  .github/workflows/poll-abandoned-carts.yml                    GH Actions — every 2h
  .github/workflows/check-late-fulfillments.yml                 GH Actions — every 6h

HOUSEKEEPING DELETES (do by hand):
  app/api/admin/backfill-drafts/backfill-customer-names-route.ts
  app/api/admin/backfill-drafts/backfill-sc-ids-route.ts

GITHUB SECRETS REQUIRED (one-time setup in repo Settings → Secrets → Actions):
  CRON_SECRET    — same value as in Vercel env vars
  APP_URL        — https://your-app.vercel.app  (no trailing slash)

AFTER COMMIT:
  Push to main. GitHub Actions picks up the workflow files within a minute.
  Tab: Actions. You'll see both cron jobs listed. Click one → "Run workflow"
  to fire it manually the first time and confirm it works. After that GH
  runs them on the schedule automatically.

  If a run fails, GitHub emails you by default (inherits notification
  preferences from your account). The `exit 1` on non-200 status ensures
  HTTP failures surface as red-X workflow runs.

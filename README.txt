Drop `fix/` contents over your repo. Three files, all touching the SC-ID
pagination timeout issue that's been hitting the Vercel function cap.

MODIFIED (1):
  app/api/cron/check-late-fulfillments/route.ts
    Removed the SC backfill block. Now only does the Shopify reconciliation.
    Should finish in <5s every time.

NEW (2):
  app/api/cron/backfill-sc-ids/route.ts
    Dedicated SC backfill endpoint with an adaptive page budget — starts
    with the targeted lookup (fast when SC respects filters), then falls
    back to pagination with only as many pages as the remaining time
    allows. At 18s/page observed on Autososs, that's typically 3 pages.

  .github/workflows/backfill-sc-ids.yml
    Runs every 2h at :45 past. Staggered from the other two (:15) to
    avoid hammering Vercel at the same minute.

NO ACTION NEEDED on vercel.json — it still pings check-late-fulfillments
once daily as a backup, and that endpoint is now safe.

AFTER COMMIT:
  1. Push to main
  2. GitHub Actions → Backfill Sellercloud IDs → Run workflow (confirm 200)
  3. Re-run the failed "Check late fulfillments" workflow — should be green
     in ~2s now that the SC walk is out of its way.

NOTES ON AUTOSOSS SPECIFICALLY:
  Your Vercel log showed 18s per SC page. At that speed:
    - 3 pages per run = 750 SC orders scanned
    - 12 runs/day = 9,000 SC orders scanned daily
  That's roughly a week's worth of orders. If SC import lag is shorter
  than that, you'll catch everything. If not, click /health → Backfill
  Sellercloud IDs to kick a manual run.

  The real fix is upstream: SC support should not have that endpoint
  taking 18s. If possible, open a ticket with them about
  /rest/api/Orders list performance on your instance. Even fixing it to
  1s per page would let a single run scan the whole backlog in seconds.

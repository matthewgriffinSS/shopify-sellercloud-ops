-- 003_ops_pass.sql
--
-- Run this BEFORE deploying the ops-pass code (the new sync route writes to
-- sync_runs, so the table has to exist first). Safe to re-run: everything is
-- IF NOT EXISTS or naturally idempotent.
--
-- Run once against Postgres via the Neon SQL Editor. The two UPDATE
-- statements at the bottom may take 10-30 seconds the first time — they're
-- doing the one-time heavy cleanup so the cron never has to.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Sync run log — powers the "Synced 23m ago" header indicator and
--    gives /health a place to look when something seems off.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sync_runs (
  id               SERIAL PRIMARY KEY,
  ran_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ok               BOOLEAN NOT NULL,
  triggered_by     TEXT,            -- 'cron' | 'user'
  elapsed_ms       INT,
  orders_upserted  INT,
  carts_upserted   INT,
  auto_recovered   INT,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_ran ON sync_runs (ran_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 2. Expression index for cart recovery. The sync matches
--    raw_payload->>'checkout_token' against cart tokens every run; without
--    this index that's a full-table JSON extraction that gets slower as
--    shopify_orders grows.
-- ─────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_orders_checkout_token
  ON shopify_orders ((raw_payload->>'checkout_token'));

-- ─────────────────────────────────────────────────────────────────────
-- 3. One-time storage cleanup. The sync route now maintains these limits
--    on every run; this is just the initial heavy lift.
-- ─────────────────────────────────────────────────────────────────────

-- Webhook audit rows older than 30 days. The chatty-webhook era left a lot
-- of these behind; only the draft webhooks write here now.
DELETE FROM webhook_log
WHERE received_at < NOW() - INTERVAL '30 days';

-- Full Shopify JSON payloads on old, fulfilled orders. Nothing reads a
-- payload after the cart's 7-day recovery window — the dashboard queries
-- select real columns. Unfulfilled orders keep theirs (they're the
-- late-fulfillment working set, and there are few of them).
UPDATE shopify_orders
SET raw_payload = NULL
WHERE raw_payload IS NOT NULL
  AND fulfillment_status = 'fulfilled'
  AND shopify_created_at < NOW() - INTERVAL '60 days';

-- Same for old carts (the email composer only reads payloads inside the
-- 7-day dashboard window) and old drafts (per-rep view shows 30 days).
UPDATE abandoned_checkouts
SET raw_payload = NULL
WHERE raw_payload IS NOT NULL
  AND abandoned_at < NOW() - INTERVAL '60 days';

UPDATE shopify_draft_orders
SET raw_payload = NULL
WHERE raw_payload IS NOT NULL
  AND shopify_created_at < NOW() - INTERVAL '60 days';

-- Note: Postgres reclaims the freed space gradually (autovacuum), so the
-- storage number in the Neon console drifts down over the following hours
-- rather than dropping instantly.

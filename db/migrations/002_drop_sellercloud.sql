-- 002_drop_sellercloud.sql
--
-- Removes every Sellercloud-related column from the schema. The business has
-- moved off Sellercloud (to Sage 500, no API access), so the dashboard's SC
-- integration is fully gone — client, crons, backfills, UI column, and now the
-- backing columns.
--
-- ORDER MATTERS: deploy the code changes first. Specifically, every
-- `sellercloud_error IS NULL` clause must already be removed from lib/queries.ts
-- (fetchLateFulfillments, fetchVipOrders, fetchMetrics ×3, fetchAbandonedCarts)
-- and the `sellercloud_order_id` SELECTs gone. If a live query still references
-- one of these columns when this migration runs, that query will throw
-- "column ... does not exist".
--
-- Run once against Postgres via the Neon SQL Editor. Not reversible.

ALTER TABLE shopify_orders     DROP COLUMN IF EXISTS sellercloud_order_id;
ALTER TABLE processing_actions DROP COLUMN IF EXISTS sellercloud_note_id;
ALTER TABLE processing_actions DROP COLUMN IF EXISTS sellercloud_error;

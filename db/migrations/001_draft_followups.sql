-- Adds per-draft follow-up tracking columns to shopify_draft_orders.
-- Replaces the Google Sheet follow-up columns (eMail / SMS / Phone / Notes / Richpanel / Can Delete).
--
-- Run this once against your existing Postgres DB via Neon SQL Editor.
-- Safe to re-run: all additions are IF NOT EXISTS.

ALTER TABLE shopify_draft_orders
  ADD COLUMN IF NOT EXISTS customer_phone     TEXT,
  ADD COLUMN IF NOT EXISTS service_type       TEXT,
  ADD COLUMN IF NOT EXISTS followed_up        BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_followup     BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sms_followup       BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sms_date           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS phone_followup     BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS phone_call_date    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS converted_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS richpanel_link     TEXT,
  ADD COLUMN IF NOT EXISTS rep_notes          TEXT,
  ADD COLUMN IF NOT EXISTS can_delete         BOOLEAN     NOT NULL DEFAULT FALSE;

-- Indexes that matter for the per-rep page query.
CREATE INDEX IF NOT EXISTS idx_drafts_service     ON shopify_draft_orders (service_type);
CREATE INDEX IF NOT EXISTS idx_drafts_can_delete  ON shopify_draft_orders (can_delete);
CREATE INDEX IF NOT EXISTS idx_drafts_followed_up ON shopify_draft_orders (followed_up);

-- Backfill converted_at for any draft that already has a converted_order_id.
-- Uses shopify_created_at as a best-guess timestamp since we don't know when it actually converted.
UPDATE shopify_draft_orders
SET converted_at = shopify_created_at
WHERE converted_order_id IS NOT NULL
  AND converted_at IS NULL;

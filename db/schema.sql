-- Schema for Shopify + Sellercloud ops dashboard.
-- Run this once against your Postgres DB to set up tables.

CREATE TABLE IF NOT EXISTS shopify_orders (
  id                    BIGINT PRIMARY KEY,
  order_number          TEXT NOT NULL,
  customer_name         TEXT,
  customer_email        TEXT,
  total_price           NUMERIC(10, 2) NOT NULL,
  currency              TEXT,
  financial_status      TEXT,
  fulfillment_status    TEXT,
  source_name           TEXT,
  tags                  TEXT[] DEFAULT '{}',
  is_vip                BOOLEAN DEFAULT FALSE,
  assigned_rep          TEXT,
  service_type          TEXT,
  sellercloud_order_id  TEXT,
  raw_payload           JSONB,
  shopify_created_at    TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_fulfillment ON shopify_orders (fulfillment_status);
CREATE INDEX IF NOT EXISTS idx_orders_vip         ON shopify_orders (is_vip);
CREATE INDEX IF NOT EXISTS idx_orders_rep         ON shopify_orders (assigned_rep);
CREATE INDEX IF NOT EXISTS idx_orders_created     ON shopify_orders (shopify_created_at DESC);

CREATE TABLE IF NOT EXISTS shopify_draft_orders (
  id                    BIGINT PRIMARY KEY,
  name                  TEXT NOT NULL,
  customer_name         TEXT,
  customer_email        TEXT,
  customer_phone        TEXT,
  total_price           NUMERIC(10, 2) NOT NULL,
  status                TEXT,
  tags                  TEXT[] DEFAULT '{}',
  assigned_rep          TEXT,
  service_type          TEXT,
  converted_order_id    BIGINT,
  -- Per-rep follow-up tracking. Replaces the "Draft Order Follow Up" Google Sheet.
  followed_up           BOOLEAN     NOT NULL DEFAULT FALSE,
  email_followup        BOOLEAN     NOT NULL DEFAULT FALSE,
  sms_followup          BOOLEAN     NOT NULL DEFAULT FALSE,
  sms_date              TIMESTAMPTZ,
  phone_followup        BOOLEAN     NOT NULL DEFAULT FALSE,
  phone_call_date       TIMESTAMPTZ,
  converted_at          TIMESTAMPTZ,
  richpanel_link        TEXT,
  rep_notes             TEXT,
  can_delete            BOOLEAN     NOT NULL DEFAULT FALSE,
  raw_payload           JSONB,
  shopify_created_at    TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_drafts_rep         ON shopify_draft_orders (assigned_rep);
CREATE INDEX IF NOT EXISTS idx_drafts_status      ON shopify_draft_orders (status);
CREATE INDEX IF NOT EXISTS idx_drafts_service     ON shopify_draft_orders (service_type);
CREATE INDEX IF NOT EXISTS idx_drafts_can_delete  ON shopify_draft_orders (can_delete);
CREATE INDEX IF NOT EXISTS idx_drafts_followed_up ON shopify_draft_orders (followed_up);

CREATE TABLE IF NOT EXISTS abandoned_checkouts (
  id                BIGINT PRIMARY KEY,
  token             TEXT,
  customer_email    TEXT,
  customer_name     TEXT,
  total_price       NUMERIC(10, 2) NOT NULL,
  line_item_count   INT,
  abandoned_at      TIMESTAMPTZ NOT NULL,
  assigned_rep      TEXT,
  contacted_at      TIMESTAMPTZ,
  recovered_at      TIMESTAMPTZ,
  raw_payload       JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ac_abandoned ON abandoned_checkouts (abandoned_at DESC);

-- Every action a rep takes gets logged here. This is what powers the
-- "Needs action / In progress / Processed" status on the dashboard.
CREATE TABLE IF NOT EXISTS processing_actions (
  id                    SERIAL PRIMARY KEY,
  resource_type         TEXT NOT NULL,  -- 'order' | 'draft_order' | 'abandoned_checkout'
  resource_id           TEXT NOT NULL,
  action_type           TEXT NOT NULL,  -- 'mark_fulfilled' | 'add_note' | 'escalate' | 'release_hold' | 'mark_processed' | 'contacted' | 'recovery_email_sent'
  actor                 TEXT,           -- which user took the action
  payload               JSONB,          -- tracking #, note text, etc.
  sellercloud_note_id   TEXT,           -- populated on successful SC post
  sellercloud_error     TEXT,           -- error message if SC call failed
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_actions_resource ON processing_actions (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_actions_created  ON processing_actions (created_at DESC);

-- Audit log for every webhook we receive, useful for debugging.
CREATE TABLE IF NOT EXISTS webhook_log (
  id            SERIAL PRIMARY KEY,
  topic         TEXT NOT NULL,
  shopify_id    TEXT,
  signature_ok  BOOLEAN NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed     BOOLEAN DEFAULT FALSE,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_weblog_received ON webhook_log (received_at DESC);

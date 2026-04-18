# Shopify + Sellercloud ops dashboard

A Next.js app on Vercel that replaces five Shopify Flows (late fulfillment, draft order follow-up, order reference, VIP $2000+, abandoned cart $2000+) with a single unified dashboard. Webhook handlers receive Shopify events, a Postgres database is the system of record, and actions taken on the dashboard post notes back to Sellercloud.

## What each old flow maps to

| Old Shopify Flow | New equivalent |
|---|---|
| Late fulfillment (3-day wait → tag) | `check-late-fulfillments` cron + "Late fulfillments" table |
| Draft order follow-up (7 rep branches) | `draft-orders-create` webhook + `DraftsByRep` component |
| Order reference (log every order) | `orders-create` webhook (orders table is the log) |
| VIP order over $2000 | `orders-create` webhook (`is_vip` flag) + `VipOrders` component |
| Abandoned cart $2000+ | `checkouts-abandoned` webhook + `AbandonedCarts` component |

## Project structure

```
app/
├── layout.tsx, page.tsx, globals.css       Dashboard UI
├── components/                              Server + client components
│   ├── Metrics.tsx                          Management KPIs
│   ├── LateFulfillments.tsx                 Support team section
│   ├── VipOrders.tsx                        Support team section
│   ├── DraftsByRep.tsx                      Sales team section
│   ├── AbandonedCarts.tsx                   Sales team section
│   ├── ActionForm.tsx                       Client component — posts to SC
│   └── shared.tsx                           TagPill, formatters
└── api/
    ├── webhooks/shopify/                   4 webhook handlers
    ├── actions/process-order/              Action form submit endpoint
    └── cron/check-late-fulfillments/       6-hourly cron job
lib/
├── db.ts, queries.ts                        Postgres client + queries
├── shopify.ts                               HMAC verify + Admin API
├── sellercloud.ts                           Token auth + note/shipment posts
├── tags.ts                                  Parse rep + service from tags
└── webhook-log.ts                           Audit logging
db/schema.sql                                DDL for all tables
scripts/init-db.ts                           Applies schema
vercel.json                                  Cron config
```

## Setup

### 1. Clone and install

```sh
npm install
cp .env.example .env.local
```

### 2. Provision Postgres

Easiest options: **Vercel Postgres**, **Neon**, or **Supabase**. Paste the connection string into `.env.local` as `DATABASE_URL`, then:

```sh
npm run db:init
```

### 3. Shopify: register webhooks

In Shopify admin, create a custom app with Admin API access. Copy the admin API token to `.env.local` as `SHOPIFY_ADMIN_API_TOKEN`. Then register these four webhooks — either in the Shopify admin UI (Settings → Notifications → Webhooks) or via API. The endpoint URLs should point to your deployed Vercel app:

| Topic | URL |
|---|---|
| `orders/create` | `https://your-app.vercel.app/api/webhooks/shopify/orders-create` |
| `orders/updated` | `https://your-app.vercel.app/api/webhooks/shopify/orders-updated` |
| `draft_orders/create` | `https://your-app.vercel.app/api/webhooks/shopify/draft-orders-create` |
| `draft_orders/update` | `https://your-app.vercel.app/api/webhooks/shopify/draft-orders-create` |
| `checkouts/update` | `https://your-app.vercel.app/api/webhooks/shopify/checkouts-abandoned` |

All webhooks use the same shared secret. Set it in `.env.local` as `SHOPIFY_WEBHOOK_SECRET`. Format: **JSON**.

### 4. Sellercloud: endpoint verification required

The `lib/sellercloud.ts` client uses these endpoint paths as plausible defaults:

- `POST /api/token` — auth
- `GET  /api/Orders?ExternalOrderId=<id>` — find SC order by Shopify ID
- `POST /api/Orders/<id>/Notes` — post a note
- `POST /api/Orders/<id>/Shipments` — create shipment

**Before shipping, verify these paths against your Sellercloud instance's API docs.** Sellercloud has multiple API generations (legacy SOAP vs newer REST) and self-hosted vs SaaS instances differ. The shapes of request/response bodies may need adjusting — check the TODOs in `lib/sellercloud.ts`.

The "Mark fulfilled" action also assumes your SC orders carry the Shopify order ID in an `ExternalOrderId` field. If your field mapping is different, change `findScOrderByShopifyId`.

### 5. Deploy to Vercel

```sh
npx vercel
```

Add all environment variables from `.env.example` in the Vercel project settings. The `vercel.json` file auto-configures the cron job — it calls `/api/cron/check-late-fulfillments` every 6 hours with `Authorization: Bearer $CRON_SECRET`.

### 6. Migration plan (recommended order)

Don't turn off the Shopify Flows until each webhook is confirmed working. Suggested rollout:

1. Deploy the app and wire in webhooks while Flows are still running — no conflict, just duplicate logging.
2. Confirm new orders appear in the dashboard within a few seconds of being created in Shopify.
3. Test the action form on one dev order — confirm the note appears on the Sellercloud side.
4. Let the cron run for a full day to populate late fulfillments.
5. Turn off the old Shopify Flows one at a time, starting with Order reference (lowest risk).

## Extending

Common next steps once the foundation is stable:

- **Auth** — add a simple SSO / password wall on the dashboard (Vercel has first-party auth options). Currently anyone with the URL can see the data.
- **Role-based views** — filter the dashboard per user (support reps only see late/VIP, sales reps only see drafts/abandoned). Add a `users` table and a middleware check.
- **Inventory alerts** — new table + SC inventory endpoint, surface low-stock SKUs on the dashboard.
- **Action history drawer** — click a row to see its full `processing_actions` log.
- **Customer VIP tagging** — when an order hits VIP status, flag the `customer_id` so future orders inherit VIP without needing another $2k threshold check.
- **Recovery email templates** — hook the abandoned cart "send recovery" action into your ESP (Klaviyo / Mailchimp / Postmark).
- **Slack notifications** — post to #ops when an order goes 7+ days late.

## Troubleshooting

**Webhook signature failures** — check `SHOPIFY_WEBHOOK_SECRET` matches the secret Shopify shows when you register the webhook. All four webhooks share one secret.

**"DATABASE_URL not set"** — Vercel serverless functions need env vars to be set in the project settings, not just in `.env.local`. Re-deploy after setting them.

**Sellercloud 401 errors** — the token cache may be stale. Redeploy to clear in-memory state, or verify credentials with a direct curl to the auth endpoint.

**Cron not running** — Vercel Hobby plan limits cron frequency. Check the Vercel dashboard → Deployments → Functions → Cron for the last run.

## Licence

Internal use only.

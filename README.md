# Shopify + Sellercloud ops dashboard

A Next.js app on Vercel that replaces five Shopify Flows (late fulfillment, draft order follow-up, order reference, VIP $2000+, abandoned cart $2000+) with a single unified dashboard. Webhook handlers receive Shopify events, a Postgres database is the system of record, and actions taken on the dashboard post notes back to Sellercloud.

**Auth model** matches the `ss-dashboard` app: Shopify client ID + secret mint tokens automatically via the `client_credentials` grant, and dashboard access is gated by a single shared password. No OAuth install flow, no user accounts, no SSO config.

## What each old flow maps to

| Old Shopify Flow | New equivalent |
|---|---|
| Late fulfillment (3-day wait → tag) | `check-late-fulfillments` cron + "Late fulfillments" table |
| Draft order follow-up (7 rep branches) | `draft-orders-create` webhook + per-rep page at `/drafts/<rep>` |
| Draft Order Follow Up Google Sheet (per-rep tabs) | Per-rep pages at `/drafts/<rep>` with inline-editable follow-up state |
| Order reference (log every order) | `orders-create` webhook (orders table is the log) |
| VIP order over $2000 | `orders-create` webhook (`is_vip` flag) + `VipOrders` component |
| Abandoned cart $2000+ | `checkouts-abandoned` webhook + `AbandonedCarts` component |

## Setup on Vercel (no terminal required)

### 1. Get the code onto GitHub

- Unzip this folder on your computer.
- Go to [github.com](https://github.com), create a new **Private** repo called `shopify-sellercloud-ops`.
- Click the "uploading an existing file" link on the new empty repo.
- Drag all the files from the unzipped folder into the browser, commit.

### 2. Deploy to Vercel

- Go to [vercel.com/new](https://vercel.com/new), import the repo, click **Deploy**. First build will fail — that's fine, you don't have a database yet.

### 3. Add Neon Postgres

- In the Vercel project → **Storage** → **Create Database** → **Neon Postgres** → pick a region → **Create**. `DATABASE_URL` is auto-injected.
- Click **Open in Neon** → **SQL Editor** → paste the contents of `db/schema.sql` → **Run**.

### 4. Set environment variables

In Vercel → **Settings → Environment Variables**, add these:

| Name | Where to find it |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `yourstore.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Shopify Partners → your app → Configuration |
| `SHOPIFY_CLIENT_SECRET` | Shopify Partners → your app → Configuration |
| `SHOPIFY_WEBHOOK_SECRET` | Shopify Partners → your app → Configuration → Webhook subscriptions |
| `DASHBOARD_PASSWORD` | Pick a shared password for your team |
| `SELLERCLOUD_API_URL` | Your SC instance URL |
| `SELLERCLOUD_USERNAME` | SC user |
| `SELLERCLOUD_PASSWORD` | SC password |
| `CRON_SECRET` | Any long random string |

### 5. Register Shopify webhooks

In Shopify Partners → your app → **Configuration** → **Webhook subscriptions** (or in the Shopify admin **Settings → Notifications → Webhooks**). Register five webhooks, all in JSON format:

| Event | URL |
|---|---|
| `orders/create` | `https://your-app.vercel.app/api/webhooks/shopify/orders-create` |
| `orders/updated` | `https://your-app.vercel.app/api/webhooks/shopify/orders-updated` |
| `draft_orders/create` | `https://your-app.vercel.app/api/webhooks/shopify/draft-orders-create` |
| `draft_orders/update` | `https://your-app.vercel.app/api/webhooks/shopify/draft-orders-create` |
| `checkouts/update` | `https://your-app.vercel.app/api/webhooks/shopify/checkouts-abandoned` |

### 6. Redeploy

Vercel → **Deployments** → `⋯` → **Redeploy**. Visit the URL. You'll see the login screen — enter your `DASHBOARD_PASSWORD`.

## Shopify scopes

The client_credentials grant uses the scopes declared on your Shopify Partners app. Set these in Shopify Partners → your app → Configuration → Admin API access scopes:

- `read_orders`
- `read_draft_orders`
- `read_customers`
- `read_fulfillments`
- `read_checkouts`

Add write scopes later when you want to close the loop back to Shopify (e.g. `write_fulfillments` for creating fulfillments from the dashboard).

## Project structure

```
app/
├── layout.tsx, page.tsx, globals.css       Dashboard UI (auth-gated)
├── login/page.tsx                          Shared-password login screen
├── components/                              Dashboard sections
└── api/
    ├── login/                              POST to log in, DELETE to log out
    ├── webhooks/shopify/                   4 Shopify webhook handlers
    ├── actions/process-order/              Action form submit endpoint
    └── cron/check-late-fulfillments/       6-hourly cron
lib/
├── auth.ts                                  Cookie-based auth (ss-dashboard pattern)
├── db.ts, queries.ts                        Postgres client + queries
├── shopify.ts                               client_credentials token auth + Admin API
├── sellercloud.ts                           Token auth + note/shipment posts
├── tags.ts                                  Parse rep + service from tags
└── webhook-log.ts                           Audit logging
db/schema.sql                                DDL for all tables
scripts/init-db.ts                           Schema init (optional, use Neon SQL Editor)
vercel.json                                  Cron config
```

## Sellercloud: endpoint verification required

The `lib/sellercloud.ts` client uses these endpoint paths as plausible defaults:

- `POST /api/token` — auth
- `GET  /api/Orders?ExternalOrderId=<id>` — find SC order by Shopify ID
- `POST /api/Orders/<id>/Notes` — post a note
- `POST /api/Orders/<id>/Shipments` — create shipment

**Before shipping, verify these paths against your Sellercloud instance's API docs.** Sellercloud has multiple API generations (legacy SOAP vs newer REST) and self-hosted vs SaaS instances differ. Check the comments in `lib/sellercloud.ts`.

## Security notes

- `DASHBOARD_PASSWORD` gates the UI via an HTTP-only signed cookie (7-day expiry). Rotating `DASHBOARD_AUTH_SECRET` (or `DASHBOARD_PASSWORD`) invalidates all existing sessions.
- Webhook endpoints are NOT gated by the dashboard password — they verify Shopify's HMAC signature instead. Anyone who can reach `/api/webhooks/*` but can't forge a valid signature gets a 401.
- The cron endpoint is gated by `CRON_SECRET` via a Bearer token. Vercel sends this automatically on scheduled runs.
- Env vars are never exposed to the browser.

## Migration plan

1. Deploy everything while old Shopify Flows are still running — webhooks will just log into the new DB without conflict.
2. Confirm new orders show up in the dashboard within seconds.
3. Test the action form on one dev order — confirm a note shows up in Sellercloud.
4. Let the cron run for a full day so late fulfillments populate.
5. Turn off the five old Shopify Flows one at a time.

## Extending

Likely next steps:

- **Role-based filtering** — show support reps only the Support sections, sales reps only the Sales sections
- **Customer-level VIP tagging** — when an order hits VIP, tag the customer so repeat orders inherit it
- **Inventory alerts** — pull low-stock SKUs from Sellercloud and surface them
- **Action history drawer** — click a row to see its full `processing_actions` log
- **Slack notifications** — post to #ops when a late order crosses a threshold

## Dashboard layout

The dashboard is split into two clearly separated routes so each team only sees what they actually work on:

- **`/support`** — Late fulfillments + VIP orders (Support team)
- **`/sales`** — Draft follow-ups by rep + abandoned carts (Sales team)
- **`/`** — Landing page with two buttons to choose

Both team pages share the top-line Metrics strip and each has a one-click link to the other page in the header.

## Draft follow-up pages (replaces the Google Sheet)

The old "Draft Order Follow Up" sheet had one tab per rep with columns for email/SMS/phone follow-up checkboxes, dates, richpanel links, notes, and a "Can Delete" flag. That lives here now — streamlined to the columns that actually get used day-to-day.

**Per-rep pages.** From `/sales`, click a rep's tile under "Draft order follow-ups by rep" to land on `/drafts/<rep>`. Each row is a draft order assigned to that rep, with inline-editable checkboxes and text fields that save as you edit.

**Tabs on each rep page:**
- **Needs follow-up** — no email, SMS, or call logged yet. The pile to work first.
- **Waiting** — at least one follow-up logged, waiting on the customer. From here a draft either auto-removes (customer pays → converted), gets closed out (dead lead, off-Shopify sale), or gets put back on follow-up via the ↻ Chase again button.

Each tab shows a count badge so reps can see at a glance which pile to work first.

**Columns:** Invoice # · Amount · Phone · Date Created · Email · SMS · SMS Date · Phone · Phone Date · Richpanel · Notes · Actions. Customer email was intentionally dropped — reps can click the invoice # to reach the draft directly in Shopify admin.

**Auto-hidden rows:**
- Status must be `invoice_sent`. Drafts still in `open` status (invoice not yet sent) are excluded.
- Created within the last 60 days. Older drafts drop off automatically.
- Service tags (`sdss` / `install` / `rebuild` / `shock service`) excluded.
- Converted drafts (those Shopify has linked to a real order via `order_id`) disappear the instant the webhook fires. No rep action needed for normal Shopify checkouts.
- Rows closed out by the rep (Close Out checkbox) are hidden.

**Date auto-stamping.** Checking **SMS** or **Phone** auto-stamps the timestamp in the adjacent date column. Unchecking clears it.

**↻ Chase again** (Actions column, shown only on Waiting tab rows): clears the three follow-up checkmarks + their dates in one click, returning the draft to the Needs follow-up tab so the rep can log a fresh round. Prompts for confirmation before clearing.

**Close Out** (Actions column): hides the row permanently. Use for phone/check sales (customer paid outside Shopify so the draft never converts automatically) or drafts that won't convert at all. The underlying record stays — this is a soft filter, not destructive.

**Rep-owned fields are protected from webhook updates.** When Shopify sends a `draft_orders/update`, we refresh the customer/tags/status/totals but deliberately do NOT overwrite any of the follow-up columns a rep has edited. See the `ON CONFLICT` clause in `app/api/webhooks/shopify/draft-orders-create/route.ts`.

### Running the database migration

If you already deployed an earlier version of this app, run `db/migrations/001_draft_followups.sql` against your database **once** to add the new columns. Open the Neon SQL Editor, paste the file, and hit Run. It's idempotent (all `IF NOT EXISTS`), so it's safe to re-run.

Fresh installs don't need to run the migration — `db/schema.sql` already includes the new columns.

## Troubleshooting

**"Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET / SHOPIFY_STORE_DOMAIN"** — one of the three env vars isn't set in Vercel, or you didn't redeploy after setting them.

**Webhook 401 Invalid signature** — `SHOPIFY_WEBHOOK_SECRET` doesn't match the signing secret in Shopify Partners. Copy-paste it exactly, then redeploy.

**Token exchange failed: 401** — client ID/secret are wrong, or the app isn't installed on the store. The client_credentials grant requires the app to be distributed as a custom app for the merchant.

**Cron not running** — Vercel Hobby plan limits cron frequency. Check Vercel → Deployments → Functions → Cron. Upgrade to Pro if you need sub-daily schedules.

**Dashboard won't accept password** — did you redeploy after setting `DASHBOARD_PASSWORD`? Env var changes need a redeploy to take effect.

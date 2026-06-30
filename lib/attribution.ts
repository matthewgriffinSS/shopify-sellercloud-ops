// lib/attribution.ts
//
// Monthly sales-attribution engine. Reuses this app's Shopify client
// (lib/shopify) and tag parser (lib/tags). Pulls one calendar month of
// orders + your RingCentral call log, matches orders to your phone contacts,
// and flags whether each order is tagged to you. Email matching (from a
// Zendesk CSV) happens client-side in app/attribution/Attribution.tsx,
// because there's no Zendesk API here.
//
// New env vars (Shopify + auth reuse what you already have):
//   RINGCENTRAL_CLIENT_ID, RINGCENTRAL_CLIENT_SECRET, RINGCENTRAL_JWT
//   RINGCENTRAL_SERVER   (optional, default https://platform.ringcentral.com)
//   RINGCENTRAL_EXTENSION(optional, default "~" = the JWT user's own calls)
//   ATTRIBUTION_LASTNAME (optional, default "griffin" — must be a KNOWN_REP)

import { shopifyRequestRaw, parseNextPageInfo } from '@/lib/shopify'
import { parseTags } from '@/lib/tags'

const LASTNAME = (process.env.ATTRIBUTION_LASTNAME || 'griffin').toLowerCase()

export type AttrOrder = {
  id: string
  name: string
  createdAt: string
  total: number
  currency: string
  financial: string
  fulfillment: string
  customer: string
  emails: string[]        // normalized, from Shopify
  phones: string[]        // normalized 10-digit, from Shopify
  matchedPhone: string | null // set here, from RingCentral
  yourTag: boolean        // parseTags(tags).rep === LASTNAME
  taggedChannels: string[] // channel prefixes of tags ending in "-<lastname>"
  tags: string            // raw comma-joined
}

export type AttrReport = {
  generatedAt: string
  month: string
  window: { since: string; until: string }
  lastname: string
  phoneContacts: number
  warnings: string[]
  orders: AttrOrder[]
}

// ---------- normalizers ----------
function normEmail(s: unknown): string {
  return String(s ?? '').trim().toLowerCase()
}
function nanp(s: unknown): string | null {
  let d = String(s ?? '').replace(/[^\d]/g, '')
  if (d.length === 11 && d[0] === '1') d = d.slice(1)
  if (d.length !== 10) return null
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null // valid US number; rejects ids/timestamps
  return d
}
function uniq<T>(a: T[]): T[] {
  return [...new Set(a)]
}

// ---------- Shopify orders (broader read than lib/shopify's type) ----------
type RawOrder = {
  id: number
  name?: string
  order_number?: number
  email?: string | null
  contact_email?: string | null
  phone?: string | null
  total_price?: string
  currency?: string
  financial_status?: string | null
  fulfillment_status?: string | null
  tags?: string
  created_at?: string
  customer?: {
    first_name?: string | null
    last_name?: string | null
    email?: string | null
    phone?: string | null
  } | null
  billing_address?: { phone?: string | null } | null
  shipping_address?: { phone?: string | null } | null
}

// The channel prefixes of any tag whose final token is your last name,
// e.g. "phone-griffin" -> "phone", "shock service-griffin" -> "shock service".
function channelsForLastname(tagsRaw: string): string[] {
  const out: string[] = []
  for (const t of tagsRaw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    const parts = t.split(/[-\s]+/).filter(Boolean)
    if (parts[parts.length - 1] === LASTNAME) {
      out.push(parts.length > 1 ? parts.slice(0, -1).join('-') : '(none)')
    }
  }
  return uniq(out)
}

function mapOrder(o: RawOrder): AttrOrder {
  const fn = (o.customer?.first_name || '').trim()
  const ln = (o.customer?.last_name || '').trim()
  const tagsRaw = o.tags || ''
  return {
    id: String(o.id),
    name: o.name || '#' + (o.order_number ?? o.id),
    createdAt: o.created_at || '',
    total: parseFloat(o.total_price || '0') || 0,
    currency: o.currency || 'USD',
    financial: o.financial_status || '',
    fulfillment: o.fulfillment_status || 'unfulfilled',
    customer: fn || ln ? `${fn} ${ln}`.trim() : '—',
    emails: uniq([o.email, o.contact_email, o.customer?.email].map(normEmail).filter(Boolean)) as string[],
    phones: uniq(
      [o.phone, o.customer?.phone, o.billing_address?.phone, o.shipping_address?.phone].map(nanp).filter(Boolean),
    ) as string[],
    matchedPhone: null,
    yourTag: parseTags(tagsRaw).rep === LASTNAME,
    taggedChannels: channelsForLastname(tagsRaw),
    tags: tagsRaw,
  }
}

async function fetchOrdersInRange(sinceISO: string, untilISO: string): Promise<AttrOrder[]> {
  const q = new URLSearchParams({
    status: 'any',
    created_at_min: sinceISO,
    created_at_max: untilISO,
    limit: '250',
  })
  const out: AttrOrder[] = []
  let path: string | null = `/orders.json?${q.toString()}`
  let pages = 0
  const MAX_PAGES = 20 // 20 × 250 = 5,000 orders / month
  while (path && pages < MAX_PAGES) {
    const { body, linkHeader } = await shopifyRequestRaw<{ orders: RawOrder[] }>(path)
    for (const o of body.orders) out.push(mapOrder(o))
    pages += 1
    // Once page_info is in play, only `limit` carries on later pages (cursor holds the filters).
    const cursor = parseNextPageInfo(linkHeader)
    path = cursor ? `/orders.json?limit=250&page_info=${encodeURIComponent(cursor)}` : null
  }
  return out
}

// ---------- RingCentral call log -> phone contact set ----------
async function fetchCallPhones(sinceISO: string, untilISO: string): Promise<Set<string>> {
  const server = process.env.RINGCENTRAL_SERVER || 'https://platform.ringcentral.com'
  const clientId = process.env.RINGCENTRAL_CLIENT_ID
  const clientSecret = process.env.RINGCENTRAL_CLIENT_SECRET || ''
  const jwt = process.env.RINGCENTRAL_JWT
  const ext = process.env.RINGCENTRAL_EXTENSION || '~'
  if (!clientId || !jwt) throw new Error('not configured')

  const tokRes = await fetch(`${server}/restapi/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  if (!tokRes.ok) throw new Error(`auth ${tokRes.status} ${(await tokRes.text()).slice(0, 160)}`)
  const token = (await tokRes.json()).access_token as string

  const phones = new Set<string>()
  const perPage = 1000
  for (let page = 1; page <= 10; page++) {
    const url =
      `${server}/restapi/v1.0/account/~/extension/${ext}/call-log` +
      `?view=Simple&dateFrom=${encodeURIComponent(sinceISO)}&dateTo=${encodeURIComponent(untilISO)}` +
      `&perPage=${perPage}&page=${page}`
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) throw new Error(`call-log ${r.status} ${(await r.text()).slice(0, 160)}`)
    const j: any = await r.json()
    const records: any[] = j.records || []
    for (const rec of records) {
      const party = rec.direction === 'Inbound' ? rec.from : rec.to // the customer side
      const p = nanp(party?.phoneNumber)
      if (p) phones.add(p)
    }
    const totalPages = j.paging?.totalPages || 1
    if (page >= totalPages || records.length < perPage) break
  }
  return phones
}

// ---------- orchestrator ----------
export async function buildReport(month: string): Promise<AttrReport> {
  const [y, m] = month.split('-').map(Number)
  const since = new Date(Date.UTC(y, m - 1, 1)) // first instant of the month (UTC)
  const until = new Date(Date.UTC(y, m, 1)) // first instant of next month (exclusive)
  const sinceISO = since.toISOString()
  const untilISO = until.toISOString()

  const warnings: string[] = []

  // Shopify orders (reuses your existing client + client_credentials token).
  const orders = await fetchOrdersInRange(sinceISO, untilISO)

  // RingCentral phone contacts (skipped gracefully if not configured yet).
  let phoneSet = new Set<string>()
  if (process.env.RINGCENTRAL_CLIENT_ID && process.env.RINGCENTRAL_JWT) {
    try {
      phoneSet = await fetchCallPhones(sinceISO, untilISO)
    } catch (e: any) {
      warnings.push('RingCentral: ' + (e?.message || e))
    }
  } else {
    warnings.push('RingCentral not configured — phone matches off (email matches via the Zendesk CSV still work)')
  }

  for (const o of orders) {
    o.matchedPhone = o.phones.find((p) => phoneSet.has(p)) || null
  }

  return {
    generatedAt: new Date().toISOString(),
    month,
    window: { since: sinceISO, until: untilISO },
    lastname: LASTNAME,
    phoneContacts: phoneSet.size,
    warnings,
    orders,
  }
}

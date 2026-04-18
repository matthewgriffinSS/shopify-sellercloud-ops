import { KNOWN_REPS, SERVICE_TAGS } from '@/lib/tags'

/**
 * Renders the most "meaningful" tag for a given order.
 * Returns the service+rep tag, colored by whether it looks auto-assigned.
 */
export function TagPill({
  rep,
  service,
  tags,
}: {
  rep: string | null
  service: string | null
  tags: string[]
}) {
  if (!rep && !service) {
    const first = tags[0]
    if (!first) return <span style={{ color: 'var(--text-3)', fontSize: 11 }}>no tags</span>
    return <span className="tag-p">{first}</span>
  }

  const repMatch = rep ? (KNOWN_REPS as readonly string[]).includes(rep) : false
  const serviceMatch = service ? (SERVICE_TAGS as readonly string[]).includes(service) : false
  // Heuristic: if both rep and service are recognised, it matches the auto-tag format.
  const cls = repMatch && serviceMatch ? 'tag-p auto' : 'tag-p man'
  const label = service ? `${service}-${rep ?? '?'}` : (rep ?? '')

  return <span className={cls}>{label}</span>
}

export function formatMoney(value: number | string): string {
  const n = typeof value === 'string' ? parseFloat(value) : value
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n)
}

export function daysAgo(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 86_400_000)
}

export function timeAgo(date: Date): string {
  const ms = Date.now() - date.getTime()
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return `${Math.floor(ms / 60_000)}m ago`
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

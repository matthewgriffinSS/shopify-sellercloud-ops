// Parses rep name + service type from Shopify tags.
// Examples: "install-griffin", "shock service-bryan", "rebuild-nick", "sdss-hector"
// Rules: rep name always appears at the end of the tag.

export const KNOWN_REPS = [
  'griffin',
  'bryan',
  'nick',
  'hector',
  'boggs',
  'bowman',
  'joe',
  'jeff',
] as const

export type Rep = (typeof KNOWN_REPS)[number]

export const SERVICE_TAGS = ['sdss', 'install', 'rebuild', 'shock service'] as const

export type ServiceType = (typeof SERVICE_TAGS)[number]

export type ParsedTags = {
  rep: Rep | null
  service: ServiceType | null
  raw: string[]
}

/**
 * Parse Shopify tags (array or comma-string) to extract the assigned rep
 * and service type.
 *
 * The rep is always the last token of a tag, separated by "-" or whitespace.
 * The service prefix determines the service type.
 */
export function parseTags(tags: string[] | string | undefined | null): ParsedTags {
  const list = normaliseTags(tags)

  let rep: Rep | null = null
  let service: ServiceType | null = null

  for (const tag of list) {
    const lower = tag.toLowerCase().trim()

    // Check for service prefix - sort by length DESC so "shock service" matches before "service".
    const sorted = [...SERVICE_TAGS].sort((a, b) => b.length - a.length)
    for (const svc of sorted) {
      if (lower.startsWith(svc)) {
        service = svc as ServiceType
        const remainder = lower.slice(svc.length).replace(/^[-\s]+/, '')
        if (isRep(remainder)) rep = remainder
        break
      }
    }

    // Fallback: bare rep tag at the end
    if (!rep) {
      const parts = lower.split(/[-\s]+/).filter(Boolean)
      const last = parts[parts.length - 1]
      if (last && isRep(last)) rep = last
    }
  }

  return { rep, service, raw: list }
}

export function isVipOrder(totalPrice: number): boolean {
  return totalPrice >= 2000
}

function normaliseTags(tags: string[] | string | undefined | null): string[] {
  if (!tags) return []
  if (Array.isArray(tags)) return tags.map((t) => t.trim()).filter(Boolean)
  return tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

function isRep(value: string): value is Rep {
  return (KNOWN_REPS as readonly string[]).includes(value)
}

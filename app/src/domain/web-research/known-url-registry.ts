import { normalizeFetchUrl } from '@/domain/web-fetch/normalize-fetch-url'

export type KnownUrlEntry = {
  normalizedUrl: string
  host: string
  sourceType: string
}

function normalizeForRegistry(url: string): string | null {
  return normalizeFetchUrl(url)
}

export class KnownUrlRegistry {
  private entries = new Map<string, KnownUrlEntry>()

  add(url: string, sourceType: string): KnownUrlEntry | null {
    const normalizedUrl = normalizeForRegistry(url)
    if (!normalizedUrl) return null
    const host = new URL(normalizedUrl).hostname.toLowerCase()
    const entry = { normalizedUrl, host, sourceType }
    this.entries.set(normalizedUrl, entry)
    return entry
  }

  has(url: string): boolean {
    const normalizedUrl = normalizeForRegistry(url)
    return normalizedUrl ? this.entries.has(normalizedUrl) : false
  }

  hosts(): Set<string> {
    return new Set([...this.entries.values()].map((entry) => entry.host))
  }

  urls(): string[] {
    return [...this.entries.keys()]
  }
}

/**
 * #1021 D-B1: a `web_fetch` megnyithatja a user saját üzeneteiben szereplő linket. A worker ezeket a
 * user üzeneteiből (nem a modell kimenetéből) gyűjti ki, és hash-elve, fejlécben igazolja a platformnak.
 *
 * A normalizálásnak és a hash-nek bájtra egyeznie kell a platformmal
 * (`app/src/domain/web-fetch/web-fetch.ts` → `normalizeWebUrl`, `webUrlHash`).
 */
import { createHash } from 'node:crypto'

export const USER_URLS_HEADER = 'x-excellence-user-urls'
const MAX_URLS = 100

export function normalizeWebUrl(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.username || parsed.password) return null
  if (parsed.port && !(parsed.protocol === 'https:' && parsed.port === '443')) return null
  parsed.protocol = 'https:'
  parsed.hash = ''
  if (!parsed.hostname.trim().toLowerCase().replace(/\.$/, '')) return null
  return parsed.toString()
}

export const webUrlHash = (normalizedUrl: string) => createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 32)

/** Mondatvégi írásjel le; a záró zárójel csak akkor, ha nincs párja a linkben (pl. wiki/Foo_(bar)). */
function trimTrailing(url: string): string {
  let out = url
  for (;;) {
    const last = out.at(-1)
    if (!last) return out
    const unbalanced = last === ')' && out.split('(').length < out.split(')').length
    if (!(/[.,;:!?\]}>'"»”]/.test(last) || unbalanced)) return out
    out = out.slice(0, -1)
  }
}

/** A szövegben szereplő http(s) linkek (markdown-linkben is). */
export function urlsInText(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)].map((m) => trimTrailing(m[0]))
}

/** A user üzeneteinek linkjei hash-elve, a legújabbak elöl (legfeljebb 100). */
export function userUrlHashes(messages: ReadonlyArray<{ role: string; content: string }>): string[] {
  const hashes = new Set<string>()
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user') continue
    for (const url of urlsInText(message.content)) {
      const normalized = normalizeWebUrl(url)
      if (normalized) hashes.add(webUrlHash(normalized))
      if (hashes.size >= MAX_URLS) return [...hashes]
    }
  }
  return [...hashes]
}

/** A megnyitandó oldal domainje az állapotszöveghez („Megnyitom az oldalt: mnb.hu…”). */
export function urlDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const normalized = normalizeWebUrl(raw)
  return normalized ? new URL(normalized).hostname.replace(/^www\./, '') : null
}

/** #946 megjelenítési segédek a wiki-nézethez. */

export function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1
  return `${value.toLocaleString(locale === 'en' ? 'en-GB' : 'hu-HU', { maximumFractionDigits: digits })} ${units[unit]}`
}

export function formatWhen(iso: string, locale: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(locale === 'en' ? 'en-GB' : 'hu-HU', { dateStyle: 'medium', timeStyle: 'short' })
}

export function wikiHref(connectorId: string, query: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value)
  const qs = params.toString()
  return `/control-plane/knowledge/${connectorId}${qs ? `?${qs}` : ''}`
}

/**
 * #1139: a kért fül, ha a néző elérheti. Fül nélkül a Fájlok az alapnézet, kivéve ha a hivatkozás
 * wiki-tartalomra mutat: oldalra, forrásra, korábbi verzióra vagy korábbi állapotra.
 */
export function resolveWikiTab<T extends string>(
  query: { tab?: string; page?: string; source?: string; rev?: string; from?: string; to?: string; asOf?: string },
  tabs: readonly T[],
): T | 'files' | 'wiki' {
  if (query.tab && (tabs as readonly string[]).includes(query.tab)) return query.tab as T
  return query.page || query.source || query.rev || query.from || query.to || query.asOf ? 'wiki' : 'files'
}

/** A szerviz tartalék nevei, ha a névadó munkatárs már nem található. */
const UNKNOWN_AGENT_KB_NAME = 'Agent knowledge base'
const UNKNOWN_PUBLIC_KB_NAME = 'Public knowledge base'

/** #1139: a tudásbázis neve a felületen, technikai azonosító és fordítatlan alapnév nélkül. */
export function wikiDisplayName(
  t: (key: 'names.catalog' | 'names.agent' | 'names.agentUnknown' | 'names.public' | 'names.publicUnknown', values?: { name: string }) => string,
  wiki: { kind: 'catalog' | 'agent' | 'shared' | 'private' | 'members' | 'public'; name: string },
): string {
  if (wiki.kind === 'catalog') return t('names.catalog')
  if (wiki.kind === 'agent') return wiki.name === UNKNOWN_AGENT_KB_NAME ? t('names.agentUnknown') : t('names.agent', { name: wiki.name })
  if (wiki.kind === 'public') return wiki.name === UNKNOWN_PUBLIC_KB_NAME ? t('names.publicUnknown') : t('names.public', { name: wiki.name })
  return wiki.name
}

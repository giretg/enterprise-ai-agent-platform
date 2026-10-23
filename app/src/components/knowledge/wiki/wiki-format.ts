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

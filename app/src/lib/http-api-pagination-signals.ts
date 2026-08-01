/** Gyakori API pageSize értékek — ennyi sor gyakran EGY oldal, nem a teljes lista. */
export const COMMON_HTTP_PAGE_SIZES = new Set([10, 20, 25, 50, 100])

const LIST_ENDPOINTS = new Set(['ownerships', 'partners', 'owners', 'customers', 'accounts'])

/**
 * Azok a végpontok, ahol egyetlen GET oldal üzletileg nem használható teljes
 * nyilvántartásként. Ezeket a Tool Broker `http_api_get_all` felé tereli.
 */
export function requiresHttpApiGetAll(path: string | null | undefined): boolean {
  const segments = (path ?? '')
    .split('?')[0]
    ?.split('/')
    .filter(Boolean)
    .map((segment) => segment.toLocaleLowerCase('en-US'))
  const lastSegment = segments?.at(-1)
  return lastSegment != null && LIST_ENDPOINTS.has(lastSegment)
}

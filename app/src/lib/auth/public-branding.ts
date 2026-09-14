/**
 * Nyilvános branding-oldalak — a Google OAuth consent-képernyő verifikációja
 * ezeket olvassa: honlap, adatvédelmi tájékoztató, ÁSZF.
 *
 * Közös forrás a Clerk-allowlistnek, a crawler-allowlistnek és a robots.txt-nek,
 * hogy a három kapu ne csússzon el egymástól. A minták SZŰKEK: a `/` csak a
 * gyökeret jelenti, nem a control-plane-t.
 */
export const PUBLIC_BRANDING_PATHS = ['/', '/privacy', '/gtc'] as const

/** Clerk `createRouteMatcher` minták: pontos path + opcionális alút. */
export const PUBLIC_BRANDING_ROUTE_PATTERNS = [
  '/',
  '/privacy',
  '/privacy/(.*)',
  '/gtc',
  '/gtc/(.*)',
] as const

export function normalizePublicPathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname
}

export function isPublicBrandingPath(pathname: string): boolean {
  const normalized = normalizePublicPathname(pathname)
  return (PUBLIC_BRANDING_PATHS as readonly string[]).includes(normalized)
}

/**
 * Nyilvános branding-oldalak — a Google OAuth consent-képernyő verifikációja
 * ezeket olvassa: honlap, adatvédelmi tájékoztató, ÁSZF.
 *
 * A locale-katalógus az `src/i18n/config.ts`-ben lakik, hogy a next-intl
 * routing, a Clerk-allowlist, a crawler-allowlist és a robots.txt ugyanazt a
 * listát lássa. A minták SZŰKEK: a `/` csak a gyökeret jelenti, a `/hu` nem
 * nyitja ki a control-plane-t.
 */
import {
  allPublicBrandingPaths,
  isPublicBrandingPath as isCatalogPublicBrandingPath,
  normalizePublicPathname,
  publicBrandingRoutePatterns,
} from '@/i18n/config'

export { normalizePublicPathname }

export const PUBLIC_BRANDING_PATHS = allPublicBrandingPaths()

/** Clerk `createRouteMatcher` minták: pontos path + opcionális alút a jogi oldalakon. */
export const PUBLIC_BRANDING_ROUTE_PATTERNS = publicBrandingRoutePatterns()

export function isPublicBrandingPath(pathname: string): boolean {
  return isCatalogPublicBrandingPath(pathname)
}

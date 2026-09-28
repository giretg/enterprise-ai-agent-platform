/**
 * Locale catalog.
 *
 * Public marketing pages (`/`, `/privacy`, `/gtc`) are locale-prefixed
 * (`/hu`, `/en/privacy`). The control plane and auth stay unprefixed; their
 * UI language follows the `NEXT_LOCALE` cookie (same HU/EN switcher). To add
 * a public page later, append it to `publicPathnames` and add
 * `app/[locale]/…/page.tsx` plus matching keys in `src/messages/{hu,en}.json`.
 */
export const locales = ['hu', 'en'] as const
export type AppLocale = (typeof locales)[number]

export const defaultLocale: AppLocale = 'hu'

export const localePrefix = 'always' as const

/** Internal pathnames (no locale prefix). Shared by routing, Clerk, robots, crawler allowlist. */
export const publicPathnames = ['/', '/privacy', '/gtc'] as const
export type PublicPathname = (typeof publicPathnames)[number]

export const PUBLIC_SITE_ORIGIN = 'https://ai.excellencepay.com'

/**
 * Unprefixed URLs kept for Google OAuth verification and existing bookmarks.
 * Middleware rewrites them to the locale-prefixed page without changing the
 * address bar, so `/privacy` keeps serving English at the canonical OAuth URL.
 */
export const unprefixedPublicAliases = {
  '/privacy': 'en',
  '/gtc': 'hu',
} as const satisfies Partial<Record<Exclude<PublicPathname, '/'>, AppLocale>>

export function isAppLocale(value: string): value is AppLocale {
  return (locales as readonly string[]).includes(value)
}

export function normalizePublicPathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname
}

export function localizedPublicPath(pathname: PublicPathname, locale: AppLocale): string {
  if (pathname === '/') return `/${locale}`
  return `/${locale}${pathname}`
}

export function allPublicBrandingPaths(): string[] {
  const paths = new Set<string>(publicPathnames)
  for (const locale of locales) {
    for (const path of publicPathnames) {
      paths.add(localizedPublicPath(path, locale))
    }
  }
  return [...paths]
}

export function isPublicBrandingPath(pathname: string): boolean {
  return allPublicBrandingPaths().includes(normalizePublicPathname(pathname))
}

/** Clerk `createRouteMatcher` patterns: exact path, plus optional subpath on legal pages. */
export function publicBrandingRoutePatterns(): string[] {
  const patterns: string[] = []
  for (const path of allPublicBrandingPaths()) {
    patterns.push(path)
    const isLocaleHome = locales.some((locale) => path === `/${locale}`)
    if (path !== '/' && !isLocaleHome) {
      patterns.push(`${path}/(.*)`)
    }
  }
  return patterns
}

export function unprefixedAliasLocale(pathname: string): AppLocale | null {
  const normalized = normalizePublicPathname(pathname)
  if (normalized === '/privacy' || normalized === '/gtc') {
    return unprefixedPublicAliases[normalized]
  }
  return null
}

export function robotsAllowRules(): string[] {
  return [
    '/$',
    ...locales.map((locale) => `/${locale}$`),
    ...publicPathnames.filter((path) => path !== '/'),
    ...locales.map((locale) => `/${locale}/`),
  ]
}

import type { AppLocale } from './config'

/** Must match `routing.localeCookie.name` in `routing.ts`. */
export const LOCALE_COOKIE = 'NEXT_LOCALE'

const MAX_AGE_SECONDS = 60 * 60 * 24 * 365

export function localeCookieHeader(locale: AppLocale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax`
}

export function writeLocaleCookie(locale: AppLocale) {
  document.cookie = localeCookieHeader(locale)
}

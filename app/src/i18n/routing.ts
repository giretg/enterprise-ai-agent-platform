import { defineRouting } from 'next-intl/routing'
import { defaultLocale, localePrefix, locales, publicPathnames } from './config'

export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix,
  localeCookie: {
    name: 'NEXT_LOCALE',
    maxAge: 60 * 60 * 24 * 365,
  },
  pathnames: {
    '/': '/',
    '/privacy': '/privacy',
    '/gtc': '/gtc',
  } satisfies Record<(typeof publicPathnames)[number], string>,
})

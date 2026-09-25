import { hasLocale } from 'next-intl'
import { getRequestConfig } from 'next-intl/server'
import { cookies } from 'next/headers'
import { defaultLocale } from './config'
import './global'
import { LOCALE_COOKIE } from './locale-cookie'
import { routing } from './routing'

export default getRequestConfig(async ({ requestLocale, locale: explicitLocale }) => {
  let requested = explicitLocale ?? (await requestLocale)
  if (!hasLocale(routing.locales, requested)) {
    try {
      requested = (await cookies()).get(LOCALE_COOKIE)?.value
    } catch {
      requested = undefined
    }
  }
  const locale = hasLocale(routing.locales, requested) ? requested : defaultLocale

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  }
})

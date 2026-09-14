import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { PUBLIC_SITE_ORIGIN, locales, type AppLocale, type PublicPathname } from './config'
import { getPathname } from './navigation'

export async function publicPageMetadata(input: {
  locale: AppLocale
  pathname: PublicPathname
  titleKey: 'homeTitle' | 'privacyTitle' | 'gtcTitle'
  descriptionKey: 'homeDescription' | 'privacyDescription' | 'gtcDescription'
  absoluteTitle?: boolean
}): Promise<Metadata> {
  const t = await getTranslations({ locale: input.locale, namespace: 'Metadata' })
  const languages: Record<string, string> = {
    'x-default': `${PUBLIC_SITE_ORIGIN}${getPathname({ locale: 'hu', href: input.pathname })}`,
  }
  for (const locale of locales) {
    languages[locale] = `${PUBLIC_SITE_ORIGIN}${getPathname({ locale, href: input.pathname })}`
  }
  const canonical = `${PUBLIC_SITE_ORIGIN}${getPathname({ locale: input.locale, href: input.pathname })}`
  const title = t(input.titleKey)
  return {
    title: input.absoluteTitle ? { absolute: title } : title,
    description: t(input.descriptionKey),
    robots: { index: true, follow: true },
    alternates: { canonical, languages },
  }
}

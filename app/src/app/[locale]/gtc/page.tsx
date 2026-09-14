import { getTranslations, setRequestLocale } from 'next-intl/server'
import { LegalPage } from '@/components/public-site/public-site-shell'
import { legalBodies } from '@/content/public/legal'
import { defaultLocale, isAppLocale } from '@/i18n/config'
import { publicPageMetadata } from '@/i18n/metadata'

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!isAppLocale(locale)) return {}
  return publicPageMetadata({
    locale,
    pathname: '/gtc',
    titleKey: 'gtcTitle',
    descriptionKey: 'gtcDescription',
  })
}

export default async function GtcPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params
  const locale = isAppLocale(raw) ? raw : defaultLocale
  setRequestLocale(locale)
  const t = await getTranslations('Terms')
  const Body = legalBodies.gtc[locale]
  return (
    <LegalPage title={t('title')} description={t('description')} updated={t('updated')}>
      <Body />
    </LegalPage>
  )
}

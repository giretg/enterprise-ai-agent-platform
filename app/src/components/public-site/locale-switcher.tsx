'use client'

import { useLocale, useTranslations } from 'next-intl'
import { locales, type AppLocale } from '@/i18n/config'
import { Link, usePathname } from '@/i18n/navigation'

export function LocaleSwitcher() {
  const locale = useLocale()
  const pathname = usePathname()
  const t = useTranslations('LocaleSwitcher')

  return (
    <div
      role="navigation"
      aria-label={t('label')}
      className="inline-flex rounded-full border border-line bg-card p-0.5"
    >
      {locales.map((code) => {
        const active = code === locale
        return (
          <Link
            key={code}
            href={pathname}
            locale={code}
            hrefLang={code}
            title={code === 'hu' ? 'Magyar' : 'English'}
            className={`rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide transition-colors ${
              active ? 'bg-coral text-white' : 'text-ink-soft hover:text-ink'
            }`}
            aria-current={active ? 'true' : undefined}
          >
            {t(code as AppLocale)}
          </Link>
        )
      })}
    </div>
  )
}

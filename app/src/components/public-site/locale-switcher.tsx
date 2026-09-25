'use client'

import { useLocale, useTranslations } from 'next-intl'
import { usePathname as useNextPathname, useRouter } from 'next/navigation'
import { isPublicBrandingPath, locales, type AppLocale } from '@/i18n/config'
import { writeLocaleCookie } from '@/i18n/locale-cookie'
import { Link, usePathname } from '@/i18n/navigation'

const TITLE: Record<AppLocale, string> = { hu: 'Magyar', en: 'English' }

function switcherClass(active: boolean) {
  return `rounded-sm px-2.5 py-1 font-mono text-xs font-semibold tracking-wide transition-colors ${
    active ? 'bg-ink text-white' : 'text-ink-soft hover:text-ink'
  }`
}

export function LocaleSwitcher() {
  const locale = useLocale()
  const pathname = usePathname()
  const nextPathname = useNextPathname()
  const router = useRouter()
  const t = useTranslations('LocaleSwitcher')
  const prefixed = isPublicBrandingPath(nextPathname)

  return (
    <div
      role="navigation"
      aria-label={t('label')}
      className="inline-flex rounded border border-ink bg-card p-0.5"
    >
      {locales.map((code) => {
        const active = code === locale
        if (prefixed) {
          return (
            <Link
              key={code}
              href={pathname}
              locale={code}
              hrefLang={code}
              title={TITLE[code]}
              className={switcherClass(active)}
              aria-current={active ? 'true' : undefined}
            >
              {t(code)}
            </Link>
          )
        }
        return (
          <button
            key={code}
            type="button"
            title={TITLE[code]}
            className={switcherClass(active)}
            aria-current={active ? 'true' : undefined}
            onClick={() => {
              if (active) return
              writeLocaleCookie(code)
              router.refresh()
            }}
          >
            {t(code)}
          </button>
        )
      })}
    </div>
  )
}

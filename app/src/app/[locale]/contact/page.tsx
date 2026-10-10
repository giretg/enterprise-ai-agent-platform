import { getTranslations, setRequestLocale } from 'next-intl/server'
import { ContactForm } from '@/components/public-site/contact-form'
import { PublicSiteShell } from '@/components/public-site/public-site-shell'
import { defaultLocale, isAppLocale } from '@/i18n/config'
import { publicPageMetadata } from '@/i18n/metadata'

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!isAppLocale(locale)) return {}
  return publicPageMetadata({
    locale,
    pathname: '/contact',
    titleKey: 'contactTitle',
    descriptionKey: 'contactDescription',
  })
}

export default async function ContactPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params
  const locale = isAppLocale(raw) ? raw : defaultLocale
  setRequestLocale(locale)
  const t = await getTranslations('Contact')

  return (
    <PublicSiteShell>
      <div className="mx-auto max-w-6xl px-5 pb-20 pt-12 sm:pb-28 sm:pt-20">
        <div className="mb-10 max-w-2xl sm:mb-14">
          <p className="font-mono text-xs font-medium uppercase tracking-[0.16em] text-coral">{t('eyebrow')}</p>
          <h1 className="mt-4 text-4xl font-bold leading-[1.02] tracking-[-0.05em] text-ink sm:text-6xl">{t('title')}</h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-ink-soft sm:text-lg">{t('intro')}</p>
        </div>

        <div className="grid overflow-hidden rounded-2xl border border-ink/10 bg-card shadow-[0_20px_80px_-52px_rgba(17,24,39,0.45)] lg:grid-cols-[0.83fr_1.17fr]">
          <aside className="relative flex flex-col overflow-hidden bg-ink p-7 text-white sm:p-9 lg:p-11">
            <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full border border-white/10" />
            <div className="pointer-events-none absolute -right-9 -top-12 h-52 w-52 rounded-full border border-white/10" />
            <div className="relative flex h-12 w-12 items-center justify-center rounded-xl bg-lime text-ink">
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />
              </svg>
            </div>
            <h2 className="relative mt-8 max-w-xs text-2xl font-bold leading-tight tracking-[-0.035em] sm:text-3xl">{t('sideTitle')}</h2>
            <p className="relative mt-3 max-w-sm text-sm leading-6 text-white/65">{t('sideBody')}</p>
            <div className="relative mt-9 space-y-4">
              {[t('pointOne'), t('pointTwo'), t('pointThree')].map((point) => (
                <div key={point} className="flex items-center gap-3 text-sm text-white/85">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/20 text-lime" aria-hidden>✓</span>
                  {point}
                </div>
              ))}
            </div>
            <div className="relative mt-auto border-t border-white/15 pt-7 lg:mt-14">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">{t('replyLabel')}</p>
              <p className="mt-2 text-lg font-semibold">{t('replyPromise')}</p>
            </div>
            <span className="pointer-events-none absolute bottom-0 right-0 font-mono text-[140px] font-bold leading-[0.7] tracking-[-0.12em] text-white/[0.035]" aria-hidden>EA</span>
          </aside>

          <section className="p-6 sm:p-9 lg:p-11">
            <div className="mb-7 flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.13em] text-ink-faint">{t('formEyebrow')}</p>
                <h2 className="mt-2 text-2xl font-bold tracking-[-0.04em] text-ink">{t('formTitle')}</h2>
              </div>
              <span className="hidden rounded-md border border-line bg-card-2 px-2.5 py-1.5 font-mono text-[10px] text-ink-faint sm:inline">{t('formNote')}</span>
            </div>
            <ContactForm copy={{
              name: t('name'),
              phone: t('phone'),
              email: t('email'),
              message: t('message'),
              namePlaceholder: t('namePlaceholder'),
              phonePlaceholder: t('phonePlaceholder'),
              emailPlaceholder: t('emailPlaceholder'),
              messagePlaceholder: t('messagePlaceholder'),
              submit: t('submit'),
              submitting: t('submitting'),
              success: t('success'),
              error: t('error'),
              privacy: t('privacy'),
              privacyLink: t('privacyLink'),
            }} />
          </section>
        </div>
        <p className="mt-5 text-center text-xs text-ink-faint">{t('footerNote')}</p>
      </div>
    </PublicSiteShell>
  )
}

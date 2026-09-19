import NextLink from 'next/link'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { PublicSiteShell } from '@/components/public-site/public-site-shell'
import { isAppLocale } from '@/i18n/config'
import { publicPageMetadata } from '@/i18n/metadata'
import { Link } from '@/i18n/navigation'
import { VendorLogo } from '@/components/public-site/vendor-logos'

const trustKeys = ['trustApproval', 'trustAudit', 'trustConnect', 'trustGdpr'] as const
const clients = [
  { key: 'clientClaude', mark: 'CL' },
  { key: 'clientCodex', mark: 'CX' },
  { key: 'clientChatgpt', mark: 'GP' },
  { key: 'clientCursor', mark: 'CU' },
] as const

const features = [
  {
    key: 'Mcp',
    icon: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71',
  },
  {
    key: 'Access',
    icon: 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3zm-3 9l2 2 4-4',
  },
  {
    key: 'Audit',
    icon: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5',
  },
  {
    key: 'Admin',
    icon: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  },
] as const

const vendors = ['OpenAI', 'Anthropic', 'Google', 'xAI', 'OpenRouter']

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!isAppLocale(locale)) return {}
  return publicPageMetadata({
    locale,
    pathname: '/',
    titleKey: 'homeTitle',
    descriptionKey: 'homeDescription',
    absoluteTitle: true,
  })
}

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (isAppLocale(locale)) setRequestLocale(locale)
  const t = await getTranslations('Home')
  const steps = [
    { title: t('howStep1Title'), body: t('howStep1Body') },
    { title: t('howStep2Title'), body: t('howStep2Body') },
    { title: t('howStep3Title'), body: t('howStep3Body') },
  ]

  return (
    <PublicSiteShell>
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 -z-10 opacity-[0.35] [background-image:linear-gradient(var(--color-line)_1px,transparent_1px),linear-gradient(90deg,var(--color-line)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(60rem_30rem_at_50%_0%,black,transparent)]" />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-16 pt-16 sm:pt-24 lg:grid-cols-[1fr_1fr] lg:gap-10 lg:pb-24">
          <div className="animate-rise">
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-xs font-medium text-ink-soft">
              <span className="h-1.5 w-1.5 rounded-full bg-sage animate-soul" />
              {t('badge')}
            </span>
            <h1 className="mt-6 font-display text-4xl font-semibold leading-[1.02] tracking-tight text-ink sm:text-6xl">
              <span className="sm:whitespace-nowrap">{t('heroLine1')}</span>
              <br />
              <em className="font-medium italic text-coral-deep">{t('heroLine2')}</em>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-soft sm:text-xl">{t('heroBody')}</p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <NextLink
                href="/sign-in"
                className="group inline-flex items-center gap-2 rounded-full bg-coral px-6 py-3 text-sm font-semibold text-white shadow-[0_12px_30px_-12px_rgba(178,58,85,0.6)] transition-all hover:-translate-y-0.5 hover:bg-coral-deep"
              >
                {t('ctaSignIn')}
                <span className="transition-transform group-hover:translate-x-0.5">→</span>
              </NextLink>
              <a
                href="#how"
                className="rounded-full border border-line bg-card px-6 py-3 text-sm font-semibold text-ink transition-colors hover:border-coral/40"
              >
                {t('ctaHow')}
              </a>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink-faint">
              {trustKeys.map((key) => (
                <li key={key} className="flex items-center gap-1.5">
                  <span className="text-sage">✓</span>
                  {t(key)}
                </li>
              ))}
            </ul>
          </div>

          <div className="atelier-card animate-rise overflow-hidden [animation-delay:120ms]">
            <div className="flex items-center justify-between border-b border-line bg-card-2/60 px-5 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{t('panelTitle')}</p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">{t('panelUrl')}</p>
              </div>
              <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-sage/10 px-2.5 py-1 text-[11px] font-medium text-sage">
                <span className="h-1.5 w-1.5 rounded-full bg-sage animate-soul" />
                {t('panelStatus')}
              </span>
            </div>
            <div className="space-y-4 px-4 py-5 sm:px-5">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">{t('panelClientsLabel')}</p>
              <ul className="space-y-2">
                {clients.map(({ key, mark }) => (
                  <li key={key} className="flex items-center justify-between rounded-xl border border-line bg-card px-3.5 py-2.5">
                    <span className="flex items-center gap-2.5 text-sm font-medium text-ink">
                      <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-[11px] font-semibold text-night">
                        {mark}
                      </span>
                      {t(key)}
                    </span>
                    <span className="text-[11px] font-medium text-sage">{t('clientConnected')}</span>
                  </li>
                ))}
              </ul>
              <div className="rounded-lg border border-honey/40 bg-honey/10 p-3.5">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-honey" />
                  <p className="text-xs font-semibold text-ink">{t('approvalTitle')}</p>
                </div>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-ink-faint">{t('approvalTool')}</dt>
                  <dd className="font-mono text-ink">{t('approvalToolValue')}</dd>
                  <dt className="text-ink-faint">{t('approvalPath')}</dt>
                  <dd className="text-ink">{t('approvalPathValue')}</dd>
                  <dt className="text-ink-faint">{t('approvalVia')}</dt>
                  <dd className="text-ink">{t('approvalViaValue')}</dd>
                </dl>
                <div className="mt-3 flex gap-2">
                  <span className="rounded-full bg-sage/20 px-4 py-1.5 text-[11px] font-semibold text-sage">{t('approvalApprove')}</span>
                  <span className="rounded-full bg-card px-4 py-1.5 text-[11px] font-semibold text-ink-faint">{t('approvalReject')}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-20">
        <p className="font-mono text-[12px] uppercase tracking-[0.16em] text-coral-deep">{t('whyEyebrow')}</p>
        <h2 className="mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          {t('whyTitle')}
        </h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {features.map((f) => (
            <div key={f.key} className="atelier-card p-6 transition-transform hover:-translate-y-0.5 sm:p-7">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-coral/10 text-coral-deep">
                <Icon d={f.icon} />
              </span>
              <h3 className="mt-5 font-display text-xl font-semibold text-ink">{t(`feature${f.key}Title`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{t(`feature${f.key}Body`)}</p>
            </div>
          ))}
          <div className="atelier-card p-6 sm:col-span-2 sm:p-7 lg:flex lg:items-center lg:justify-between lg:gap-10">
            <div className="max-w-xl">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-coral/10 text-coral-deep">
                <Icon d="M4 7h16M4 12h16M4 17h16M8 4v3M16 9v3M11 14v3" />
              </span>
              <h3 className="mt-5 font-display text-xl font-semibold text-ink">{t('featureModelsTitle')}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{t('featureModelsBody')}</p>
            </div>
            <ul className="mt-6 flex flex-wrap gap-2 lg:mt-0 lg:max-w-xs lg:justify-end">
              {vendors.map((v) => (
                <li key={v} title={v} className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-card text-ink-soft">
                  <VendorLogo name={v} className="h-5 w-5" />
                  <span className="sr-only">{v}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-5 pb-20">
        <div className="atelier-card p-8 sm:p-10">
          <p className="font-mono text-[12px] uppercase tracking-[0.16em] text-coral-deep">{t('howEyebrow')}</p>
          <div className="mt-6 grid gap-8 sm:grid-cols-3">
            {steps.map((s, i) => (
              <div key={s.title}>
                <p className="font-display text-4xl font-semibold text-coral/40">{i + 1}</p>
                <h3 className="mt-2 font-semibold text-ink">{s.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-soft">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-24">
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <div>
            <h2 className="font-display text-2xl font-semibold text-ink">{t('aboutTitle')}</h2>
            <p className="mt-4 leading-relaxed text-ink-soft">{t('aboutBody')}</p>
          </div>
          <div className="atelier-soft p-6 text-sm leading-relaxed text-ink-soft">
            <p>
              {t.rich('aboutCardLead', {
                brand: (chunks) => <strong className="font-semibold text-ink">{chunks}</strong>,
              })}
            </p>
            <p className="mt-3">
              {t.rich('aboutCardRest', {
                privacy: (chunks) => (
                  <Link href="/privacy" className="font-medium text-coral-deep underline underline-offset-2">
                    {chunks}
                  </Link>
                ),
                terms: (chunks) => (
                  <Link href="/gtc" className="font-medium text-coral-deep underline underline-offset-2">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          </div>
        </div>

        <div className="mt-16 overflow-hidden rounded-3xl bg-ink px-8 py-12 text-center text-night sm:px-12">
          <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t('ctaTitle')}</h2>
          <p className="mx-auto mt-3 max-w-xl text-night/70">{t('ctaBody')}</p>
          <NextLink
            href="/sign-in"
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-coral px-7 py-3 text-sm font-semibold text-white transition-colors hover:bg-rose"
          >
            {t('ctaButton')}
          </NextLink>
        </div>
      </section>
    </PublicSiteShell>
  )
}

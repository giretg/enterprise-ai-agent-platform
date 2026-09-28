import NextLink from 'next/link'
import Image from 'next/image'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { PublicSiteShell } from '@/components/public-site/public-site-shell'
import { ScrollEffects } from '@/components/public-site/signal-motion'
import { AgentChatDemo } from '@/components/public-site/agent-chat-demo'
import { isAppLocale } from '@/i18n/config'
import { publicPageMetadata } from '@/i18n/metadata'
import { Link } from '@/i18n/navigation'
import { VendorLogo } from '@/components/public-site/vendor-logos'

const trustKeys = ['trustApproval', 'trustAudit', 'trustConnect', 'trustGdpr'] as const
const clients = [
  { key: 'clientClaude', logo: '/mcp-clients/claudecode.svg' },
  { key: 'clientHermes', logo: '/mcp-clients/hermes.svg' },
  { key: 'clientChatgpt', logo: null },
  { key: 'clientCursor', logo: '/mcp-clients/cursor.svg' },
] as const
const systems = ['systemDrive', 'systemGmail', 'systemCrm', 'systemKb'] as const

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

// Diagram geometry (viewBox 1000×340): 4 clients → hub → 4 systems.
const rowsY = [46, 128, 210, 292]
const clientWires = rowsY.map((y, i) => `M180 ${y} C300 ${y} 290 ${140 + i * 20} 400 ${140 + i * 20}`)
const systemWires = rowsY.map((y, i) => `M600 ${140 + i * 20} C710 ${140 + i * 20} 700 ${y} 820 ${y}`)

const btnPrimary =
  'signal-btn inline-flex items-center gap-2.5 rounded border border-ink bg-ink px-5 py-3.5 text-sm font-semibold text-white'
const btnGhost =
  'signal-btn inline-flex items-center gap-2.5 rounded border border-ink bg-card px-5 py-3.5 text-sm font-semibold text-ink [--sweep:var(--color-lime)]'
const eyebrow =
  "font-mono text-xs uppercase tracking-[0.12em] text-coral before:text-ink-faint before:content-['//_']"

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}

function ClientMark({ logo }: { logo: string | null }) {
  return logo ? (
    <Image src={logo} alt="" width={20} height={20} className="h-5 w-5 object-contain" />
  ) : (
    <VendorLogo name="OpenAI" className="h-5 w-5" />
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
    { title: t('howStep4Title'), body: t('howStep4Body') },
    { title: t('howStep5Title'), body: t('howStep5Body') },
    { title: t('howStep6Title'), body: t('howStep6Body') },
  ]
  const stepTotal = String(steps.length).padStart(2, '0')
  const marquee = [...clients.map((c) => t(c.key)), ...systems.map((s) => t(s))]

  return (
    <PublicSiteShell>
      <ScrollEffects />

      {/* Hero */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-16 pt-16 sm:pt-24 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <span data-reveal className="inline-flex items-center gap-2.5 border border-ink bg-card px-2.5 py-1.5 font-mono text-xs uppercase tracking-[0.08em]">
            <span className="h-2 w-2 rounded-full bg-sage animate-blink" />
            {t('badge')}
          </span>
          <h1 data-reveal className="mt-6 text-5xl font-bold leading-[0.95] tracking-[-0.05em] sm:text-7xl lg:text-[5.5rem]">
            {t('heroLine1')}
            <br />
            <mark className="signal-mark text-inherit">{t('heroLine2')}</mark>
          </h1>
          <p data-reveal className="mt-6 max-w-xl text-lg leading-relaxed text-ink-soft">{t('heroBody')}</p>
          <div data-reveal className="mt-8 flex flex-wrap items-center gap-3">
            <NextLink href="/sign-in" className={btnPrimary}>
              {t('ctaSignIn')}
              <span aria-hidden className="rounded-sm border border-current px-1.5 font-mono text-[11px] opacity-70">↵</span>
            </NextLink>
            <a href="#how" className={btnGhost}>
              {t('ctaHow')}
            </a>
          </div>
          <ul data-reveal className="mt-7 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[13px] text-ink-soft">
            {trustKeys.map((key) => (
              <li key={key} className="before:text-coral before:content-['■_']">
                {t(key)}
              </li>
            ))}
          </ul>
        </div>
        <div data-reveal>
          <AgentChatDemo />
        </div>
      </section>

      {/* Marquee */}
      <div className="overflow-hidden whitespace-nowrap border-y border-ink bg-ink py-3.5 font-mono text-sm uppercase tracking-[0.1em] text-white" aria-hidden>
        <div className="inline-block animate-marquee">
          {[...marquee, ...marquee].map((label, i) => (
            <span key={i} className="mx-7 before:text-lime before:content-['✦_']">
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Architecture */}
      <section className="mx-auto max-w-6xl px-5 py-24 sm:py-28">
        <p data-reveal className={eyebrow}>{t('archEyebrow')}</p>
        <h2 data-reveal className="mt-4 max-w-[16ch] text-4xl font-bold leading-none tracking-[-0.04em] sm:text-6xl">
          {t('whyTitle')}
        </h2>
        <div data-reveal className="mt-12 overflow-x-auto border border-ink bg-card p-6 sm:p-8">
          <svg data-draw viewBox="0 0 1000 340" role="img" aria-label={t('whyTitle')} className="group block w-full min-w-[640px]">
            {clients.map((c, i) => (
              <g key={c.key}>
                <rect x="10" y={rowsY[i] - 26} width="170" height="52" rx="3" className="fill-card stroke-ink" />
                <text x="30" y={rowsY[i] + 5} className="fill-ink text-[14px] font-medium">{t(c.key)}</text>
              </g>
            ))}
            <rect x="400" y="110" width="200" height="120" rx="3" className="fill-ink" />
            <text x="428" y="160" className="fill-white text-[14px] font-medium">Excellence AI</text>
            <text x="428" y="186" className="fill-lime font-mono text-[12px]">{t('hubCaption')}</text>
            {systems.map((s, i) => (
              <g key={s}>
                <rect x="820" y={rowsY[i] - 26} width="170" height="52" rx="3" className="fill-card stroke-ink" />
                <text x="840" y={rowsY[i] + 5} className="fill-ink text-[14px] font-medium">{t(s)}</text>
              </g>
            ))}
            {[...clientWires, ...systemWires].map((d, i) => (
              <g key={d}>
                <path
                  d={d}
                  pathLength={1}
                  className="fill-none stroke-ink [stroke-dasharray:1] [stroke-dashoffset:calc(1-var(--draw,0))] [stroke-width:1.5]"
                />
                <circle r="4" className={`opacity-0 transition-opacity group-[.is-drawn]:opacity-100 ${i === 5 ? 'fill-honey' : 'fill-coral'}`}>
                  <animateMotion dur={`${2 + i * 0.3}s`} repeatCount="indefinite" path={d} />
                </circle>
              </g>
            ))}
          </svg>
        </div>
      </section>

      {/* Capabilities */}
      <section className="mx-auto max-w-6xl px-5 pb-24">
        <p data-reveal className={eyebrow}>{t('featuresEyebrow')}</p>
        <div data-reveal className="mt-8 grid border border-ink bg-card sm:grid-cols-2">
          {features.map((f, i) => (
            <div
              key={f.key}
              className={`group border-line p-7 transition-colors hover:bg-card-2 border-b ${i % 2 === 0 ? 'sm:border-r' : ''}`}
            >
              <span className="flex h-10 w-10 items-center justify-center border border-ink bg-card text-ink transition-colors group-hover:bg-lime">
                <Icon d={f.icon} />
              </span>
              <h3 className="mt-5 text-xl font-semibold tracking-[-0.02em]">{t(`feature${f.key}Title`)}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{t(`feature${f.key}Body`)}</p>
            </div>
          ))}
          <div className="p-7 sm:col-span-2 lg:flex lg:items-center lg:justify-between lg:gap-10">
            <div className="max-w-xl">
              <h3 className="text-xl font-semibold tracking-[-0.02em]">{t('featureModelsTitle')}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{t('featureModelsBody')}</p>
            </div>
            <ul className="mt-6 flex flex-wrap gap-2 lg:mt-0">
              {vendors.map((v) => (
                <li key={v} title={v} className="flex h-11 w-11 items-center justify-center border border-line bg-card text-ink-soft transition-colors hover:border-ink hover:text-ink">
                  <VendorLogo name={v} className="h-5 w-5" />
                  <span className="sr-only">{v}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* How it works — sticky steps */}
      <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-5 pb-24">
        <p data-reveal className={eyebrow}>{t('howEyebrow')}</p>
        <div className="mt-10 grid gap-10 lg:grid-cols-2 lg:gap-16">
          <div>
            {steps.map((s, i) => (
              <div
                key={s.title}
                data-step
                className="flex flex-col justify-center border-l-2 border-line py-6 pl-7 transition-[border-color,opacity] duration-300 lg:min-h-[60vh] lg:opacity-35 [&.is-on]:border-coral [&.is-on]:opacity-100"
              >
                <span className="font-mono text-[13px] text-coral">
                  {t('stepLabel', { n: String(i + 1).padStart(2, '0'), total: stepTotal })}
                </span>
                <h3 className="mt-2 text-3xl font-bold tracking-[-0.03em]">{s.title}</h3>
                <p className="mt-2.5 max-w-[42ch] text-ink-soft">{s.body}</p>
              </div>
            ))}
          </div>
          <div className="hidden lg:block">
            <div className="sticky top-28 min-h-[340px] border border-ink bg-card p-6">
              {/* 1 — AI teammate */}
              <div data-screen className="absolute inset-6 translate-y-3 opacity-0 transition duration-400 [&.is-on]:translate-y-0 [&.is-on]:opacity-100">
                <p className="text-sm font-semibold">{t('howDemoAgentName')}</p>
                <p className="mt-1 font-mono text-xs text-ink-faint">{t('howDemoAgentModel')}</p>
                <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">{t('howDemoAgentRole')}</p>
                {(
                  [
                    ['ruleDrive', 'ruleAllowed', 'text-sage'],
                    ['ruleGmail', 'ruleApproval', 'text-honey'],
                    ['ruleCrm', 'ruleApproval', 'text-honey'],
                  ] as const
                ).map(([rule, status, tone]) => (
                  <div key={rule} className="mb-2 mt-3 flex items-center gap-3 border border-line bg-card px-3.5 py-3 text-sm">
                    {t(rule)}
                    <span className={`ml-auto font-mono text-xs ${tone}`}>● {t(status)}</span>
                  </div>
                ))}
              </div>
              {/* 2 — reports */}
              <div data-screen className="absolute inset-6 translate-y-3 opacity-0 transition duration-400 [&.is-on]:translate-y-0 [&.is-on]:opacity-100">
                <p className="mb-3 text-sm font-semibold">{t('howDemoTeamLead')}</p>
                {(
                  [
                    ['howDemoMember1', 'howDemoMember1Role'],
                    ['howDemoMember2', 'howDemoMember2Role'],
                  ] as const
                ).map(([name, role]) => (
                  <div key={name} className="mb-2 flex items-center gap-3 border border-line bg-card px-3.5 py-3 text-sm">
                    <span>
                      {t(name)}
                      <span className="block font-mono text-xs text-ink-faint">{t(role)}</span>
                    </span>
                    <span className="ml-auto font-mono text-xs text-coral">● {t('howDemoMemberStatus')}</span>
                  </div>
                ))}
              </div>
              {/* 3 — connected clients */}
              <div data-screen className="absolute inset-6 translate-y-3 opacity-0 transition duration-400 [&.is-on]:translate-y-0 [&.is-on]:opacity-100">
                <p className="mb-3 truncate font-mono text-xs text-ink-faint">{t('panelUrl')}</p>
                {clients.map((c) => (
                  <div key={c.key} className="mb-2 flex items-center gap-3 border border-line bg-card px-3.5 py-2.5 text-sm">
                    <ClientMark logo={c.logo} />
                    {t(c.key)}
                    <span className="ml-auto font-mono text-xs text-sage">● {t('clientConnected')}</span>
                  </div>
                ))}
              </div>
              {/* 4 — approval */}
              <div data-screen className="absolute inset-6 translate-y-3 opacity-0 transition duration-400 [&.is-on]:translate-y-0 [&.is-on]:opacity-100">
                <div className="border border-l-4 border-honey bg-honey/5 p-4">
                  <p className="text-sm font-semibold text-honey">▲ {t('approvalTitle')}</p>
                  <dl className="mb-4 mt-3 grid grid-cols-[90px_1fr] gap-x-3 gap-y-1 text-[13px]">
                    <dt className="font-mono text-xs uppercase text-ink-faint">{t('approvalTool')}</dt>
                    <dd>{t('approvalToolValue')}</dd>
                    <dt className="font-mono text-xs uppercase text-ink-faint">{t('approvalPath')}</dt>
                    <dd>{t('approvalPathValue')}</dd>
                    <dt className="font-mono text-xs uppercase text-ink-faint">{t('approvalVia')}</dt>
                    <dd>{t('approvalViaValue')}</dd>
                  </dl>
                  <div className="flex gap-2">
                    <span className="rounded border border-sage bg-sage px-3.5 py-2 text-[13px] font-semibold text-white">{t('approvalApprove')}</span>
                    <span className="rounded border border-ink bg-card px-3.5 py-2 text-[13px] font-semibold">{t('approvalReject')}</span>
                  </div>
                </div>
              </div>
              {/* 5 — audit */}
              <div data-screen className="absolute inset-6 translate-y-3 opacity-0 transition duration-400 [&.is-on]:translate-y-0 [&.is-on]:opacity-100">
                <p className="mb-3 font-mono text-xs uppercase tracking-wide text-ink-faint">{t('howDemoAuditTitle')}</p>
                {[t('howDemoAudit1'), t('howDemoAudit2')].map((line) => (
                  <div key={line} className="mb-2 border border-line bg-card px-3.5 py-3 font-mono text-[13px]">
                    {line}
                  </div>
                ))}
                <div className="mt-4 flex items-center justify-between border border-ink bg-card-2 px-3.5 py-3 text-sm">
                  <span className="font-mono text-xs uppercase text-ink-faint">{t('howDemoAuditCost')}</span>
                  <span className="font-semibold">{t('howDemoAuditCostValue')}</span>
                </div>
              </div>
              {/* 6 — training */}
              <div data-screen className="absolute inset-6 translate-y-3 opacity-0 transition duration-400 [&.is-on]:translate-y-0 [&.is-on]:opacity-100">
                <p className="mb-3 text-sm font-semibold">{t('howDemoTrainTitle')}</p>
                {[t('howDemoTrain1'), t('howDemoTrain2')].map((item) => (
                  <div key={item} className="mb-2 flex items-center gap-3 border border-line bg-card px-3.5 py-3 text-sm">
                    {item}
                    <span className="ml-auto font-mono text-xs text-sage">● {t('howDemoTrainStatus')}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* About + CTA */}
      <section className="mx-auto max-w-6xl px-5 pb-24">
        <div data-reveal className="grid gap-6 lg:grid-cols-2">
          <div>
            <h2 className="text-3xl font-bold tracking-[-0.03em]">{t('aboutTitle')}</h2>
            <p className="mt-4 leading-relaxed text-ink-soft">{t('aboutBody')}</p>
          </div>
          <div className="border border-line bg-card p-6 text-sm leading-relaxed text-ink-soft">
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

        <div data-reveal className="mt-16 border border-ink bg-ink px-8 py-14 text-center text-white shadow-[10px_10px_0_var(--color-coral)] sm:px-12">
          <h2 className="mx-auto max-w-2xl text-3xl font-bold tracking-[-0.04em] sm:text-5xl">{t('ctaTitle')}</h2>
          <p className="mx-auto mt-4 max-w-xl text-white/70">{t('ctaBody')}</p>
          <NextLink
            href="/sign-in"
            className="signal-btn mt-8 inline-flex items-center gap-2 rounded border border-lime bg-lime px-7 py-3.5 text-sm font-semibold text-ink [--sweep:white]"
          >
            {t('ctaButton')}
          </NextLink>
        </div>
      </section>
    </PublicSiteShell>
  )
}

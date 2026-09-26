'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card } from '@/components/ui/shell'
import { HERMES_LINKS, MCP_SETUP_SEEN_COOKIE, type McpClientSetup } from '@/lib/mcp-client-setup'

function markSetupSeen() {
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${MCP_SETUP_SEEN_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const t = useTranslations('Common')

  function copy() {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep"
    >
      {copied ? t('copied') : label}
    </button>
  )
}

function CodeBlock({ value, copyLabel }: { value: string; copyLabel: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-card-2/60 p-2 sm:flex-row sm:items-center">
      <pre className="min-w-0 flex-1 overflow-x-auto px-2 py-1 font-mono text-xs leading-relaxed text-ink">
        {value}
      </pre>
      <CopyButton value={value} label={copyLabel} />
    </div>
  )
}

function ClientCard({
  name,
  description,
  logo,
  logoBackground,
  badge,
  defaultOpen,
  children,
}: {
  name: string
  description: string
  logo: string
  logoBackground: string
  badge?: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <details open={defaultOpen} className="group overflow-hidden rounded-2xl border border-line bg-card shadow-sm transition-colors hover:border-coral/35 open:border-coral/40">
      <summary className="flex cursor-pointer list-none items-center gap-4 px-4 py-3.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-coral sm:px-5 [&::-webkit-details-marker]:hidden">
        <span className={`flex size-12 shrink-0 items-center justify-center rounded-xl ${logoBackground}`}>
          <Image src={logo} alt="" width={28} height={28} className="size-7 object-contain" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-base font-semibold text-ink">
            {name}
            {badge ? (
              <span className="rounded-full bg-coral/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-coral-deep">
                {badge}
              </span>
            ) : null}
          </span>
          <span className="block text-sm text-ink-soft">{description}</span>
        </span>
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="size-5 shrink-0 text-ink-faint transition-transform group-open:rotate-180">
          <path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="space-y-3 border-t border-line bg-card-2/35 px-4 py-4 text-sm leading-relaxed text-ink-soft sm:px-5 sm:py-5">
        {children}
      </div>
    </details>
  )
}

function HermesStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-coral/10 text-xs font-semibold text-coral-deep">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-semibold text-ink">{title}</p>
        {children}
      </div>
    </li>
  )
}

export function McpSetupLanding({ setup, continueHref }: { setup: McpClientSetup; continueHref: string }) {
  const t = useTranslations('GetStarted')
  useEffect(() => {
    markSetupSeen()
  }, [])

  return (
    <div className="mx-auto max-w-4xl space-y-8 pb-8">
      <header className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-3 font-display text-3xl font-semibold leading-tight sm:text-4xl">{t('title')}</h1>
        <p className="mt-3 text-base leading-relaxed text-ink-soft">{t('body')}</p>
      </header>

      <section aria-labelledby="install-title" className="space-y-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-coral">{t('step1Eyebrow')}</p>
          <h2 id="install-title" className="mt-1 font-display text-2xl font-semibold">{t('step1Title')}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t('step1Body')}</p>
        </div>

        <div className="atelier-card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">{t('orgUrl')}</p>
            <p className="mt-1 break-all font-mono text-sm text-ink">{setup.mcpUrl}</p>
          </div>
          <CopyButton value={setup.mcpUrl} label={t('copyUrl')} />
        </div>

        <div className="space-y-3">
          <ClientCard
            name="Hermes Desktop"
            description={t('hermesDesc')}
            logo="/mcp-clients/hermes.svg"
            logoBackground="bg-[#ececf2]"
            badge={t('hermesBadge')}
            defaultOpen
          >
            <p>{t('hermesIntro')}</p>
            <ol className="space-y-4">
              <HermesStep n={1} title={t('hermesStep1Title')}>
                <p>{t('hermesStep1Body')}</p>
                <a href={HERMES_LINKS.download} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full bg-coral px-5 py-2.5 font-semibold text-white transition-colors hover:bg-coral-deep">
                  {t('hermesDownload')} <span aria-hidden="true">↗</span>
                </a>
              </HermesStep>
              <HermesStep n={2} title={t('hermesStep2Title')}>
                <p>{t('hermesStep2Body')}</p>
                <CodeBlock value="hermes model" copyLabel={t('copyCommand')} />
                <p className="text-xs text-ink-faint">{t('hermesStep2Hint')}</p>
              </HermesStep>
              <HermesStep n={3} title={t('hermesStep3Title')}>
                <p>{t('hermesStep3Body')}</p>
                <CodeBlock value={setup.hermesCommand} copyLabel={t('copyCommand')} />
                <p className="text-xs text-ink-faint">{t('hermesStep3Hint')}</p>
              </HermesStep>
              <HermesStep n={4} title={t('hermesStep4Title')}>
                <p>{t('hermesStep4Body')}</p>
                <CodeBlock value={setup.hermesSyncPrompt} copyLabel={t('copyPrompt')} />
                <p className="text-xs text-ink-faint">{t('hermesStep4Hint')}</p>
              </HermesStep>
              <HermesStep n={5} title={t('hermesStep5Title')}>
                <p>{t('hermesStep5Body')}</p>
                <p className="text-xs text-ink-faint">{t('hermesApprovalHint')}</p>
              </HermesStep>
            </ol>
            <div className="rounded-xl border border-line bg-card p-3">
              <p className="font-semibold text-ink">{t('hermesUpdateTitle')}</p>
              <p className="mt-1">{t('hermesUpdateBody')}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">{t('hermesLinksTitle')}</p>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {(
                  [
                    ['hermesLinkDocs', HERMES_LINKS.docs],
                    ['hermesLinkBotMode', HERMES_LINKS.botMode],
                    ['hermesLinkMcp', HERMES_LINKS.mcp],
                    ['hermesLinkProfiles', HERMES_LINKS.profileDistributions],
                  ] as const
                ).map(([key, href]) => (
                  <li key={key}>
                    <a href={href} target="_blank" rel="noopener noreferrer" className="font-semibold text-coral-deep underline-offset-2 hover:underline">
                      {t(key)} ↗
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </ClientCard>

          <ClientCard name="Codex" description={t('codexDesc')} logo="/mcp-clients/codex.svg" logoBackground="bg-[#e6eee9]">
            <p>{t('codexBody')}</p>
            <CodeBlock value={setup.codexCommand} copyLabel={t('copyCommand')} />
          </ClientCard>

          <ClientCard name="Cursor" description={t('cursorDesc')} logo="/mcp-clients/cursor.svg" logoBackground="bg-[#eeece8]">
            <p>{t('cursorBody')}</p>
            <a href={setup.cursorInstallHref} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full bg-coral px-5 py-2.5 font-semibold text-white transition-colors hover:bg-coral-deep">
              {t('cursorInstall')} <span aria-hidden="true">→</span>
            </a>
            <p className="text-xs text-ink-faint">{t('cursorFallback')}</p>
          </ClientCard>

          <ClientCard name="Grok Build CLI" description={t('grokDesc')} logo="/mcp-clients/grok.svg" logoBackground="bg-[#eeebf4]">
            <p>{t('grokBody')}</p>
            <CodeBlock value={setup.grokCommand} copyLabel={t('copyCommand')} />
            <p className="text-xs text-ink-faint">{t('grokHint')}</p>
          </ClientCard>

          <ClientCard name="Claude Desktop" description={t('claudeDesc')} logo="/mcp-clients/claude.svg" logoBackground="bg-[#f8ede5]">
            <p>{t('claudeBody', { name: setup.serverName })}</p>
            <CodeBlock value={setup.mcpUrl} copyLabel={t('copyUrl')} />
            <p>{t('claudeAfter')}</p>
          </ClientCard>

          <ClientCard name="Claude Code" description={t('claudeCodeDesc')} logo="/mcp-clients/claudecode.svg" logoBackground="bg-[#f8ede5]">
            <p>{t('claudeCodeBody')}</p>
            <CodeBlock value={setup.claudeCommand} copyLabel={t('copyCommand')} />
            <p className="text-xs text-ink-faint">{t('claudeCodeHint')}</p>
          </ClientCard>

          <ClientCard name="Goose Desktop" description={t('gooseDesc')} logo="/mcp-clients/goose.svg" logoBackground="bg-[#e7eff1]">
            <ol className="list-decimal space-y-1 pl-5">
              <li>{t('gooseStep1')}</li>
              <li>{t('gooseStep2')}</li>
              <li>{t('gooseStep3', { name: setup.serverName })}</li>
            </ol>
            <CodeBlock value={setup.mcpUrl} copyLabel={t('copyUrl')} />
            <p>{t('gooseAfter')}</p>
          </ClientCard>
        </div>
      </section>

      <Card className="p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-coral">{t('step2Eyebrow')}</p>
        <h2 className="mt-1 font-display text-2xl font-semibold">{t('step2Title')}</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{t('step2Body')}</p>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Link href={continueHref} onClick={markSetupSeen} className="inline-flex items-center gap-2 rounded-full bg-coral px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-coral-deep">
          {t('continue')} <span aria-hidden="true">→</span>
        </Link>
        <p className="text-sm text-ink-faint">{t('reopenHint')}</p>
      </div>
    </div>
  )
}

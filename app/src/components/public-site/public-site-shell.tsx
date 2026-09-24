import Image from 'next/image'
import NextLink from 'next/link'
import type { ReactNode } from 'react'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { LocaleSwitcher } from './locale-switcher'

export async function PublicSiteShell({ children }: { children: ReactNode }) {
  const t = await getTranslations('Nav')
  const footer = await getTranslations('Footer')
  const nav = [
    { href: '/' as const, label: t('home') },
    { href: '/privacy' as const, label: t('privacy') },
    { href: '/gtc' as const, label: t('terms') },
  ]

  return (
    <div className="signal-grid flex min-h-screen flex-col text-ink">
      <header className="sticky top-0 z-20 border-b border-ink bg-night/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3.5">
          <Link href="/" className="flex min-w-0 items-center gap-3">
            <Image
              src="/excellence-ai-logo.png"
              alt="Excellence AI"
              width={44}
              height={44}
              className="h-9 w-9 rounded-md object-cover"
              priority
            />
            <div className="min-w-0">
              <p className="whitespace-nowrap text-lg font-bold leading-none tracking-[-0.03em]">
                Excellence AI
              </p>
              <p className="mt-1 hidden font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint sm:block">
                {t('tagline')}
              </p>
            </div>
          </Link>
          <nav aria-label={t('aria')} className="flex items-center gap-1 sm:gap-2">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="hidden px-3 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:text-ink sm:inline"
              >
                {item.label}
              </Link>
            ))}
            <LocaleSwitcher />
            <NextLink
              href="/sign-in"
              className="signal-btn rounded border border-ink bg-ink px-4 py-2 text-sm font-semibold text-white"
            >
              {t('signIn')}
            </NextLink>
          </nav>
        </div>
        <div data-progress className="absolute -bottom-px left-0 h-0.5 w-0 bg-coral" />
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-ink bg-card">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 py-8 text-sm text-ink-soft sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} Excellence Pay Kft. ·{' '}
            <span className="font-medium text-ink">Excellence AI</span>
          </p>
          <div className="flex flex-wrap gap-4">
            <Link href="/privacy" className="hover:text-ink">
              {footer('privacy')}
            </Link>
            <Link href="/gtc" className="hover:text-ink">
              {footer('terms')}
            </Link>
            <NextLink href="/sign-in" className="hover:text-ink">
              {footer('signIn')}
            </NextLink>
          </div>
        </div>
      </footer>
    </div>
  )
}

export async function LegalPage({
  title,
  description,
  updated,
  children,
}: {
  title: string
  description?: string
  updated: string
  children: ReactNode
}) {
  const t = await getTranslations('Legal')
  return (
    <PublicSiteShell>
      <article className="mx-auto max-w-3xl px-5 py-14 sm:py-20">
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-coral">Excellence AI</p>
        <h1 className="mt-3 text-4xl font-bold tracking-[-0.04em] text-ink sm:text-5xl">{title}</h1>
        {description ? <p className="mt-4 text-lg leading-relaxed text-ink-soft">{description}</p> : null}
        <p className="mt-3 text-sm text-ink-faint">{t('updated', { date: updated })}</p>
        <div className="mt-10 space-y-4 text-[15px] leading-7 text-ink-soft [&_a]:text-coral-deep [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-night-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-ink [&_h2]:mt-10 [&_h2]:font-display [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:text-ink [&_h3]:mt-6 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-ink [&_li]:mt-1 [&_strong]:font-semibold [&_strong]:text-ink [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
          {children}
        </div>
      </article>
    </PublicSiteShell>
  )
}

import Link from 'next/link'
import type { ReactNode } from 'react'
import { ShellAuth } from '@/components/auth/shell-auth'
import { isClerkUiEnabled } from '@/lib/clerk-config'

const linkClass = (active: boolean) =>
  `rounded-full px-3.5 py-1.5 text-sm font-medium transition-all duration-200 ${
    active
      ? 'bg-coral/15 text-ink shadow-[inset_0_0_0_1px_rgba(236,122,95,0.4)]'
      : 'text-ink-soft hover:bg-white/5 hover:text-ink'
  }`

export function AppShell({
  appName,
  appSubtitle,
  navItems,
  accentColor,
  children,
  switchLink,
  pathname,
}: {
  appName: string
  appSubtitle: string
  navItems: { href: string; label: string; exact?: boolean }[]
  accentColor: 'slate' | 'teal'
  children: ReactNode
  switchLink: { href: string; label: string }
  pathname: string
}) {
  const mark = accentColor === 'teal' ? '🪴' : '🏡'
  const markGradient =
    accentColor === 'teal'
      ? 'linear-gradient(140deg, #8fc08a, #82b6cf)'
      : 'linear-gradient(140deg, #f2b35e, #ec7a5f)'

  const isActive = (href: string, exact?: boolean) => {
    if (exact) return pathname === href
    return pathname.startsWith(href)
  }

  const clerkEnabled = isClerkUiEnabled()

  return (
    <div className="min-h-screen text-ink">
      <div className="border-b border-honey/20 bg-honey/10 px-4 py-2 text-center text-xs text-honey">
        Fázis 1 — Postgres + Gemini
        {clerkEnabled ? ' · Clerk auth aktív' : ' · dev auth (Clerk nincs beállítva)'}
      </div>
      <header className="sticky top-0 z-20 border-b border-white/8 bg-night/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-3.5">
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-3">
              <div
                className="animate-breathe flex h-11 w-11 items-center justify-center rounded-2xl text-xl"
                style={{
                  background: markGradient,
                  boxShadow:
                    'inset 0 2px 5px rgba(255,255,255,0.35), 0 8px 20px -8px rgba(236,122,95,0.6)',
                }}
              >
                {mark}
              </div>
              <div>
                <p className="font-display text-lg font-semibold leading-tight">{appName}</p>
                <p className="text-xs text-ink-faint">{appSubtitle}</p>
              </div>
            </div>
            <nav className="ml-2 hidden items-center gap-1 lg:flex">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={linkClass(isActive(item.href, item.exact))}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ShellAuth clerkEnabled={clerkEnabled} />
            <Link
              href={switchLink.href}
              className="rounded-full border border-white/12 bg-white/5 px-4 py-2 text-xs font-semibold text-ink-soft hover:border-coral/40 hover:text-ink"
            >
              {switchLink.label}
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-5 py-8">{children}</main>
    </div>
  )
}

export function Card({
  title,
  children,
  className = '',
}: {
  title?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`atelier-card p-5 ${className}`}>
      {title ? <h2 className="mb-4 font-display text-lg font-semibold">{title}</h2> : null}
      {children}
    </section>
  )
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'success' | 'warning' | 'danger'
}) {
  const tones = {
    neutral: 'bg-white/10 text-ink-soft',
    success: 'bg-sage/20 text-sage',
    warning: 'bg-honey/20 text-honey',
    danger: 'bg-coral/20 text-coral',
  }
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  )
}

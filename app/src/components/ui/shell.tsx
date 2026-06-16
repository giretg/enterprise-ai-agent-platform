import Link from 'next/link'
import type { ReactNode } from 'react'
import { ShellAuth } from '@/components/auth/shell-auth'
import { isClerkUiEnabled } from '@/lib/clerk-config'

const linkClass = (active: boolean) =>
  `relative rounded-full px-4 py-1.5 text-sm font-medium tracking-wide transition-all duration-200 ${
    active
      ? 'text-coral-deep'
      : 'text-ink-soft hover:bg-coral/8 hover:text-ink'
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
  // The estate's two cellars: the tasting room (control plane) and the
  // working press-house (sandbox). Each keeps a warm monogram & tone.
  const mark = accentColor === 'teal' ? '🍇' : '🍷'
  const markGradient =
    accentColor === 'teal'
      ? 'linear-gradient(140deg, #6f9a55, #4d86a6)'
      : 'linear-gradient(140deg, #b07d24, #b23a55)'

  const isActive = (href: string, exact?: boolean) => {
    if (exact) return pathname === href
    return pathname.startsWith(href)
  }

  const clerkEnabled = isClerkUiEnabled()

  return (
    <div className="min-h-screen text-ink">
      <div className="border-b border-honey/25 bg-honey/8 px-4 py-2 text-center text-[11px] font-medium uppercase tracking-[0.18em] text-honey">
        MVP v1 · Postgres + ChatGPT OAuth · {clerkEnabled ? 'Clerk auth' : 'dev auth'}
      </div>
      <header className="sticky top-0 z-20 border-b border-line bg-night/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div
              className="animate-breathe flex h-11 w-11 items-center justify-center rounded-2xl text-xl"
              style={{
                background: markGradient,
                boxShadow:
                  'inset 0 2px 5px rgba(255,255,255,0.4), 0 10px 22px -10px rgba(178,58,85,0.5)',
              }}
            >
              {mark}
            </div>
            <div>
              <p className="font-display text-[1.35rem] font-semibold leading-none tracking-tight">
                {appName}
              </p>
              <p className="mt-1 text-[11px] uppercase tracking-[0.16em] text-ink-faint">
                {appSubtitle}
              </p>
            </div>
          </div>

          <nav className="hidden items-center gap-1 lg:flex">
            {navItems.map((item) => {
              const active = isActive(item.href, item.exact)
              return (
                <Link key={item.href} href={item.href} className={linkClass(active)}>
                  {item.label}
                  {active && (
                    <span className="absolute -bottom-px left-1/2 h-0.5 w-5 -translate-x-1/2 rounded-full bg-coral" />
                  )}
                </Link>
              )
            })}
          </nav>

          <div className="flex shrink-0 items-center gap-2">
            <ShellAuth clerkEnabled={clerkEnabled} />
            <Link
              href={switchLink.href}
              className="rounded-full border border-line bg-card px-4 py-2 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/45 hover:text-coral-deep"
            >
              {switchLink.label}
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-5 py-9">{children}</main>
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
      {title ? (
        <h2 className="mb-4 font-display text-lg font-semibold tracking-tight">{title}</h2>
      ) : null}
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
    neutral: 'bg-ink/8 text-ink-soft',
    success: 'bg-sage/15 text-sage',
    warning: 'bg-honey/15 text-honey',
    danger: 'bg-coral/15 text-coral',
  }
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  )
}

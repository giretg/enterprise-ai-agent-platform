'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'
import { ShellAuth } from '@/components/auth/shell-auth'
import { useClerkEnabled } from '@/components/auth/providers'

export type NavLeaf = { key?: string; href: string; label: string; exact?: boolean }
export type NavGroup = { key?: string; label: string; children: NavLeaf[] }
export type NavEntry = NavLeaf | NavGroup

const isGroup = (entry: NavEntry): entry is NavGroup => 'children' in entry

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
  children,
  switchLink,
  pathname,
  headerExtra,
  layout = 'default',
}: {
  appName: string
  appSubtitle: string
  navItems: NavEntry[]
  accentColor: 'slate' | 'teal'
  children: ReactNode
  switchLink?: { href: string; label: string }
  pathname: string
  /** Fejléc-slot a bal/jobb szélen (pl. tenant-switcher). */
  headerExtra?: ReactNode
  /** `rail`: sáv + munkaterület elrendezés, nincs max-width a main-en. */
  layout?: 'default' | 'rail'
}) {
  const isActive = (href: string, exact?: boolean) => {
    if (exact) return pathname === href
    return pathname.startsWith(href)
  }
  const isGroupActive = (group: NavGroup) =>
    group.children.some((child) => isActive(child.href, child.exact))

  const clerkEnabled = useClerkEnabled()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [openGroup, setOpenGroup] = useState<string | null>(null)

  useEffect(() => {
    if (!openGroup) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      const openEl = document.querySelector('[data-open-group]')
      if (openEl && !openEl.contains(target)) setOpenGroup(null)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenGroup(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openGroup])

  const renderNavLeaf = (child: NavLeaf, childActive: boolean, onPick: () => void, compact = false) => {
    const baseClass = compact
      ? `${linkClass(childActive)} block`
      : `block rounded-xl px-3 py-2 text-sm font-medium tracking-wide transition-colors ${
          childActive ? 'bg-coral/10 text-coral-deep' : 'text-ink-soft hover:bg-coral/8 hover:text-ink'
        }`
    return (
      <Link
        key={child.href}
        href={child.href}
        role={compact ? 'menuitem' : undefined}
        onClick={onPick}
        className={baseClass}
      >
        {child.label}
        {childActive && compact ? (
          <span className="absolute -bottom-px left-1/2 h-0.5 w-5 -translate-x-1/2 rounded-full bg-coral" />
        ) : null}
      </Link>
    )
  }

  const renderTopLeaf = (item: NavLeaf) => {
    const active = isActive(item.href, item.exact)
    return (
      <Link key={item.href} href={item.href} className={linkClass(active)}>
        {item.label}
        {active && (
          <span className="absolute -bottom-px left-1/2 h-0.5 w-5 -translate-x-1/2 rounded-full bg-coral" />
        )}
      </Link>
    )
  }

  const railLayout = layout === 'rail'

  return (
    <div
      className={
        railLayout
          ? 'flex h-dvh flex-col overflow-hidden text-ink'
          : 'min-h-screen text-ink'
      }
    >
      <header
        className={`z-20 shrink-0 border-b border-line bg-night/80 backdrop-blur-xl ${
          railLayout ? '' : 'sticky top-0'
        }`}
      >
        <div className="w-full px-3 py-2.5 sm:px-5 sm:py-3.5">
          <div className="flex items-center justify-between gap-1.5 sm:gap-3">
            <div className="flex min-w-0 shrink-0 items-center gap-2 sm:gap-3">
              <Image
                src="/excellence-ai-logo.png"
                alt="Excellence AI"
                width={44}
                height={44}
                className="h-9 w-9 shrink-0 rounded-xl object-cover sm:h-11 sm:w-11 sm:rounded-2xl"
              />
              <div className="hidden min-w-0 sm:block">
                <p className="truncate font-display text-[1.2rem] font-semibold leading-none tracking-tight sm:text-[1.35rem]">
                  {appName}
                </p>
                <p className="mt-1 hidden text-[11px] uppercase tracking-[0.16em] text-ink-faint sm:block">
                  {appSubtitle}
                </p>
              </div>
            </div>

            <nav aria-label="Fő navigáció" className="hidden items-center gap-1 lg:flex">
              {navItems.map((item) => {
                if (isGroup(item)) {
                  const active = isGroupActive(item)
                  const open = openGroup === item.label
                  return (
                    <div
                      key={item.label}
                      className="relative"
                      {...(open ? { 'data-open-group': '' } : {})}
                    >
                      <button
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={open}
                        onClick={() => setOpenGroup((cur) => (cur === item.label ? null : item.label))}
                        className={`${linkClass(active)} inline-flex items-center gap-1`}
                      >
                        {item.label}
                        <svg
                          aria-hidden
                          viewBox="0 0 12 12"
                          className={`h-2.5 w-2.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                        >
                          <path d="M2.5 4.5 6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {active && (
                          <span className="absolute -bottom-px left-1/2 h-0.5 w-5 -translate-x-1/2 rounded-full bg-coral" />
                        )}
                      </button>
                      {open && (
                        <div
                          role="menu"
                          className="absolute right-0 top-full z-40 mt-2 min-w-[12rem] rounded-2xl border border-line bg-night/95 p-1.5 shadow-xl backdrop-blur-xl"
                        >
                          {item.children.map((child) => {
                            const childActive = isActive(child.href, child.exact)
                            return renderNavLeaf(child, childActive, () => setOpenGroup(null), false)
                          })}
                        </div>
                      )}
                    </div>
                  )
                }
                return renderTopLeaf(item)
              })}
            </nav>

            <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
              {headerExtra}
              <ShellAuth clerkEnabled={clerkEnabled} />
              {switchLink && (
                <Link
                  href={switchLink.href}
                  className="hidden rounded-full border border-line bg-card px-3 py-2 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/45 hover:text-coral-deep sm:inline-flex sm:px-4"
                >
                  {switchLink.label}
                </Link>
              )}
              <button
                type="button"
                aria-label={mobileMenuOpen ? 'Menü bezárása' : 'Menü megnyitása'}
                aria-expanded={mobileMenuOpen}
                aria-controls="mobile-main-navigation"
                onClick={() => setMobileMenuOpen((open) => !open)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-line bg-card text-ink-soft transition-colors hover:border-coral/45 hover:text-coral-deep sm:h-10 sm:w-10 lg:hidden"
              >
                <span className="flex w-4 flex-col gap-1">
                  <span className="h-0.5 rounded-full bg-current" />
                  <span className="h-0.5 rounded-full bg-current" />
                  <span className="h-0.5 rounded-full bg-current" />
                </span>
              </button>
            </div>
          </div>

          <nav
            id="mobile-main-navigation"
            aria-label="Mobil fő navigáció"
            className={`-mx-4 mt-3 border-t border-line/70 px-4 pt-3 lg:hidden ${
              mobileMenuOpen ? 'grid gap-1' : 'hidden'
            }`}
          >
            {navItems.map((item) => {
              if (isGroup(item)) {
                return (
                  <div key={item.label} className="mt-2 first:mt-0">
                    <p className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
                      {item.label}
                    </p>
                    {item.children.map((child) => {
                      const childActive = isActive(child.href, child.exact)
                      return renderNavLeaf(child, childActive, () => setMobileMenuOpen(false), true)
                    })}
                  </div>
                )
              }
              return renderTopLeaf(item)
            })}
            {switchLink && (
              <Link
                href={switchLink.href}
                onClick={() => setMobileMenuOpen(false)}
                className="mt-1 rounded-full border border-line bg-card px-4 py-2 text-sm font-semibold text-ink-soft transition-colors hover:border-coral/45 hover:text-coral-deep"
              >
                {switchLink.label}
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main
        className={
          railLayout
            ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
            : 'mx-auto max-w-7xl px-5 py-9'
        }
      >
        {children}
      </main>
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
    <section className={`atelier-card p-4 sm:p-5 ${className}`}>
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
  title,
}: {
  children: ReactNode
  tone?: 'neutral' | 'success' | 'warning' | 'danger'
  title?: string
}) {
  const tones = {
    neutral: 'bg-ink/8 text-ink-soft',
    success: 'bg-sage/15 text-sage',
    warning: 'bg-honey/15 text-honey',
    danger: 'bg-coral/15 text-coral',
  }
  return (
    <span title={title} className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  )
}

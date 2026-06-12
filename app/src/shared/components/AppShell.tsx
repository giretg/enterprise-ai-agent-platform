import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/react'
import { NavLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import { PrototypeBanner } from './PrototypeBanner'

const authButtonClass =
  'rounded-full border border-white/12 bg-white/5 px-4 py-2 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-ink'

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-full px-3.5 py-1.5 text-sm font-medium transition-all duration-200 ${
    isActive
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
}: {
  appName: string
  appSubtitle: string
  navItems: { to: string; label: string }[]
  accentColor: 'slate' | 'teal'
  children: ReactNode
  switchLink: { to: string; label: string }
}) {
  const mark = accentColor === 'teal' ? '🪴' : '🏡'
  const markGradient =
    accentColor === 'teal'
      ? 'linear-gradient(140deg, #8fc08a, #82b6cf)'
      : 'linear-gradient(140deg, #f2b35e, #ec7a5f)'

  return (
    <div className="min-h-screen text-ink">
      <PrototypeBanner />
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
                aria-hidden
              >
                {mark}
              </div>
              <div className="text-left">
                <p className="font-display text-lg font-semibold leading-tight text-ink">
                  {appName}
                </p>
                <p className="text-xs text-ink-faint">{appSubtitle}</p>
              </div>
            </div>
            <nav className="ml-2 hidden items-center gap-1 lg:flex">
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to.split('/').length <= 2}
                  className={linkClass}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Show when="signed-out">
              <SignInButton mode="modal">
                <button type="button" className={authButtonClass}>
                  Bejelentkezés
                </button>
              </SignInButton>
              <SignUpButton mode="modal">
                <button
                  type="button"
                  className={`${authButtonClass} border-coral/30 bg-coral/10 text-ink hover:border-coral/50`}
                >
                  Regisztráció
                </button>
              </SignUpButton>
            </Show>
            <Show when="signed-in">
              <UserButton
                appearance={{
                  elements: {
                    avatarBox: 'h-9 w-9',
                  },
                }}
              />
            </Show>
            <NavLink to={switchLink.to} className={authButtonClass}>
              {switchLink.label}
            </NavLink>
          </div>
        </div>
        <nav className="flex items-center gap-1 overflow-x-auto px-5 pb-3 lg:hidden">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to.split('/').length <= 2}
              className={linkClass}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-5 py-8">{children}</main>
    </div>
  )
}

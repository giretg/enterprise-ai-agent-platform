import { NavLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import { PrototypeBanner } from './PrototypeBanner'

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
    isActive
      ? 'bg-slate-700 text-white'
      : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
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
  const accent =
    accentColor === 'teal'
      ? 'from-teal-900/30 to-slate-900'
      : 'from-slate-900 to-slate-950'

  return (
    <div className={`min-h-screen bg-gradient-to-br ${accent} text-slate-200`}>
      <PrototypeBanner />
      <header className="border-b border-slate-700/60 bg-slate-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-4">
            <div>
              <div className="flex items-center gap-2">
                <div
                  className={`h-8 w-8 rounded-lg ${accentColor === 'teal' ? 'bg-teal-600' : 'bg-slate-600'} flex items-center justify-center text-xs font-bold text-white`}
                >
                  {accentColor === 'teal' ? 'SW' : 'CP'}
                </div>
                <div className="text-left">
                  <p className="text-sm font-semibold text-slate-100">
                    {appName}
                  </p>
                  <p className="text-xs text-slate-500">{appSubtitle}</p>
                </div>
              </div>
            </div>
            <nav className="ml-6 hidden items-center gap-1 md:flex">
              {navItems.map((item) => (
                <NavLink key={item.to} to={item.to} className={linkClass}>
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <NavLink
            to={switchLink.to}
            className="rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-500 hover:text-white"
          >
            {switchLink.label}
          </NavLink>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  )
}

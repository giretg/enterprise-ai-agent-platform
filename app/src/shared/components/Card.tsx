import type { ReactNode } from 'react'

export function Card({
  children,
  className = '',
  title,
  action,
}: {
  children: ReactNode
  className?: string
  title?: string
  action?: ReactNode
}) {
  return (
    <div className={`atelier-card ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-3.5">
          {title && (
            <h3 className="font-display text-base font-semibold text-ink">
              {title}
            </h3>
          )}
          {action}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  )
}

export function StatCard({
  label,
  value,
  sub,
  accent,
  icon,
}: {
  label: string
  value: string | number
  sub?: string
  accent?: 'green' | 'amber' | 'sky' | 'violet'
  icon?: ReactNode
}) {
  const accentColor = {
    green: 'var(--color-sage)',
    amber: 'var(--color-honey)',
    sky: 'var(--color-sky)',
    violet: 'var(--color-grape)',
  }
  const c = accent ? accentColor[accent] : 'var(--color-ink-faint)'

  return (
    <div className="atelier-card lift relative overflow-hidden p-5">
      <div
        className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full opacity-25 blur-2xl"
        style={{ background: c }}
      />
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
          {label}
        </p>
        {icon && (
          <span className="text-xl leading-none" aria-hidden>
            {icon}
          </span>
        )}
      </div>
      <p
        className="font-display mt-2 text-3xl font-semibold text-ink"
        style={{ textShadow: `0 0 28px ${c}22` }}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-ink-soft">{sub}</p>}
      <div
        className="mt-3 h-1 w-10 rounded-full"
        style={{ background: c, boxShadow: `0 0 12px ${c}99` }}
      />
    </div>
  )
}

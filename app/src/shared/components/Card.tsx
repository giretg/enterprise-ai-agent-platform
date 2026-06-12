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
    <div
      className={`rounded-lg border border-slate-700/80 bg-slate-800/50 ${className}`}
    >
      {(title || action) && (
        <div className="flex items-center justify-between border-b border-slate-700/60 px-4 py-3">
          {title && (
            <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
          )}
          {action}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  )
}

export function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string | number
  sub?: string
  accent?: 'green' | 'amber' | 'sky' | 'violet'
}) {
  const accentBorder = {
    green: 'border-l-emerald-500',
    amber: 'border-l-amber-500',
    sky: 'border-l-sky-500',
    violet: 'border-l-violet-500',
  }
  return (
    <div
      className={`rounded-lg border border-slate-700/80 bg-slate-800/50 border-l-4 ${accent ? accentBorder[accent] : 'border-l-slate-500'} p-4`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-slate-50">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  )
}

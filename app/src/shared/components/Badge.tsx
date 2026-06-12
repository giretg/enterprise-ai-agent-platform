import type { ReactNode } from 'react'

type BadgeVariant =
  | 'default'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'purple'
  | 'mono'

const variants: Record<BadgeVariant, string> = {
  default: 'bg-slate-700 text-slate-200 border-slate-600',
  success: 'bg-emerald-950 text-emerald-300 border-emerald-800',
  warning: 'bg-amber-950 text-amber-300 border-amber-800',
  danger: 'bg-red-950 text-red-300 border-red-800',
  info: 'bg-sky-950 text-sky-300 border-sky-800',
  purple: 'bg-violet-950 text-violet-300 border-violet-800',
  mono: 'bg-slate-900 text-slate-400 border-slate-700 font-mono text-[10px]',
}

export function Badge({
  children,
  variant = 'default',
  className = '',
}: {
  children: ReactNode
  variant?: BadgeVariant
  className?: string
}) {
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  )
}

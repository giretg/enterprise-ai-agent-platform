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
  default: 'bg-white/5 text-ink-soft border-white/10',
  success: 'bg-sage/12 text-sage border-sage/30',
  warning: 'bg-honey/12 text-honey border-honey/30',
  danger: 'bg-coral/15 text-coral border-coral/35',
  info: 'bg-sky/12 text-sky border-sky/30',
  purple: 'bg-grape/12 text-grape border-grape/30',
  mono: 'bg-night-2 text-ink-faint border-white/10 font-mono text-[10px]',
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
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  )
}

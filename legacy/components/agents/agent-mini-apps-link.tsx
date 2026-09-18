'use client'

import Link from 'next/link'

export function agentMiniAppsHref(agentId: string) {
  return `/control-plane/apps?agentId=${agentId}`
}

export function AgentMiniAppsLink({
  agentId,
  compact = false,
  label,
  title,
  className = '',
}: {
  agentId: string
  compact?: boolean
  /** Ha nincs megadva, a compact mód „Mini-appok”, egyébként „Mini-appok →”. */
  label?: string
  title?: string
  className?: string
}) {
  const text = label ?? (compact ? 'Mini-appok' : 'Mini-appok →')
  return (
    <Link
      href={agentMiniAppsHref(agentId)}
      title={title}
      onClick={(e) => e.stopPropagation()}
      className={
        className ||
        (compact
          ? 'rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep'
          : 'rounded-full border border-line bg-card px-5 py-2.5 text-sm font-semibold text-ink-soft transition-colors hover:border-sage/50 hover:text-sage')
      }
    >
      {text}
    </Link>
  )
}

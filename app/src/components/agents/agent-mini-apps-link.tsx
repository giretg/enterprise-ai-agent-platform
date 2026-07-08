'use client'

import Link from 'next/link'

export function agentMiniAppsHref(agentId: string) {
  return `/control-plane/apps?agentId=${agentId}`
}

export function AgentMiniAppsLink({
  agentId,
  compact = false,
  className = '',
}: {
  agentId: string
  compact?: boolean
  className?: string
}) {
  return (
    <Link
      href={agentMiniAppsHref(agentId)}
      onClick={(e) => e.stopPropagation()}
      className={
        className ||
        (compact
          ? 'rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep'
          : 'rounded-full border border-line bg-card px-5 py-2.5 text-sm font-semibold text-ink-soft transition-colors hover:border-sage/50 hover:text-sage')
      }
    >
      {compact ? 'Mini-appok' : 'Mini-appok →'}
    </Link>
  )
}

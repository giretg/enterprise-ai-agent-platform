import type { ReactNode } from 'react'
import { ProviderIcon } from '@/components/account/provider-icon'

/**
 * Egy kapcsolt fiók kompakt sora — ikon, név, egysoros összegzés, jobbra az
 * állapot és a fő művelet. A részletek (children) csak kinyitva látszanak.
 */
export function ConnectionCard({
  name,
  provider,
  summary,
  status,
  actions,
  children,
}: {
  name: string
  provider: string
  summary: ReactNode
  status?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line/70 bg-card/80 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:flex-nowrap">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line/80 bg-white shadow-sm">
          <ProviderIcon provider={provider} className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-ink">{name}</h3>
            {status}
          </div>
          <div className="mt-0.5 truncate text-xs text-ink-soft">{summary}</div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children ? (
        <div className="border-t border-line/60 bg-night-2/25 px-4 py-4">{children}</div>
      ) : null}
    </section>
  )
}

export function StatusDot({ tone, children }: { tone: 'ok' | 'warn'; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        tone === 'ok' ? 'bg-sage/15 text-sage' : 'bg-honey/15 text-honey'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone === 'ok' ? 'bg-sage' : 'bg-honey'}`} />
      {children}
    </span>
  )
}

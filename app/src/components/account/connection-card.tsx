import type { ReactNode } from 'react'
import { ProviderIcon } from '@/components/account/provider-icon'
import { Badge } from '@/components/ui/shell'

/**
 * Egy lehetséges kapcsolt fiók kártyája — Telegram, Gmail, későbbi providerek.
 * Ugyanaz a keret: név, állapot, rövid magyarázat, alatta a provider-specifikus
 * művelet (összekötés / bontás / beállítás).
 */
export function ConnectionCard({
  name,
  provider,
  description,
  connected,
  connectedDetail,
  children,
}: {
  name: string
  provider: string
  description: string
  connected: boolean
  connectedDetail?: string
  children: ReactNode
}) {
  return (
    <section className={`atelier-card overflow-hidden ${connected ? 'border-sage/30' : ''}`}>
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-line/80 bg-white shadow-sm">
            <ProviderIcon provider={provider} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-lg font-semibold tracking-tight text-ink">{name}</h2>
              <Badge tone={connected ? 'success' : 'neutral'}>
                {connected ? 'Összekötve' : 'Nincs összekötve'}
              </Badge>
            </div>
            <p className="mt-1.5 max-w-3xl text-sm leading-6 text-ink-soft">{description}</p>
            {connected && connectedDetail ? (
              <p className="mt-2 text-xs font-medium text-sage">{connectedDetail}</p>
            ) : null}
          </div>
        </div>
      </div>
      <div className="space-y-4 border-t border-line/70 bg-night-2/35 px-5 py-4 sm:px-6">
        {children}
      </div>
    </section>
  )
}

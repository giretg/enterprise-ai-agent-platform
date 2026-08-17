'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { switchTenant } from '@/app/actions/tenant'

export function AgentDetailUnavailable(
  props:
    | {
        reason: 'wrong_tenant'
        agentName: string
        tenantId: string
        tenantLabel: string
      }
    | {
        reason: 'load_failed'
        message: string
      },
) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (props.reason === 'wrong_tenant') {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-line bg-card p-8 text-center shadow-sm">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-honey">Másik tenant</p>
        <h2 className="mt-2 font-display text-2xl font-semibold text-ink">
          {props.agentName} nem ebben a tenantban van
        </h2>
        <p className="mt-3 text-sm text-ink-soft">
          Ez az agent a <span className="font-semibold text-ink">{props.tenantLabel}</span>{' '}
          tenanthoz tartozik. A lista a jelenlegi tenantot mutatja — válts, és az adatlap
          betöltődik.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setError(null)
              startTransition(async () => {
                const res = await switchTenant({ tenantId: props.tenantId })
                if (!res.success) {
                  setError(res.error)
                  return
                }
                router.refresh()
              })
            }}
            className="rounded-lg bg-coral px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-coral-deep disabled:opacity-60"
          >
            Váltás: {props.tenantLabel}
          </button>
          <Link href="/control-plane/agents" className="text-sm font-medium text-ink-soft hover:text-coral-deep">
            Vissza a csapathoz
          </Link>
        </div>
        {error ? <p className="mt-4 text-sm text-coral-deep">{error}</p> : null}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-line bg-card p-8 text-center shadow-sm">
      <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Betöltési hiba</p>
      <h2 className="mt-2 font-display text-2xl font-semibold text-ink">Az agent most nem nyílt meg</h2>
      <p className="mt-3 text-sm text-ink-soft">
        Az agent létezik, de az adatlap betöltése elakadt. A fejlécben maradsz — próbáld újra,
        vagy menj vissza a csapathoz.
      </p>
      <p className="mt-4 font-mono text-xs text-ink-faint">{props.message}</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => router.refresh()}
          className="rounded-lg bg-coral px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-coral-deep"
        >
          Újrapróbálkozás
        </button>
        <Link href="/control-plane/agents" className="text-sm font-medium text-ink-soft hover:text-coral-deep">
          Vissza a csapathoz
        </Link>
      </div>
    </div>
  )
}

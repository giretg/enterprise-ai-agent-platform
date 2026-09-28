'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { getTenantSwitcherState, switchTenant, exitTenant } from '@/app/actions/tenant'

/**
 * Fejléc tenant-switcher (Tenant-Management §9.1). Kiváltja a hardcode-olt
 * `OSTOROSBOR` feliratot: az aktív tenant nevét mutatja, és — több tenant vagy
 * superadmin esetén — legördülőből lehet váltani. A superadmin "assumed"
 * kontextusát külön jelöli, és van "kilépés" (→ platform-mód) művelete.
 */

type TenantOption = {
  id: string
  slug: string
  displayName: string
  status: string
  isMembership: boolean
}

type SwitcherState = {
  activeTenantId: string | null
  assumed: boolean
  kind: 'tenant' | 'platform' | 'none'
  isSuperadmin: boolean
  tenants: TenantOption[]
}

const statusTone: Record<string, string> = {
  active: 'text-sage',
  suspended: 'text-honey',
  offboarding: 'text-honey',
  archived: 'text-ink-faint',
}

export function TenantSwitcher() {
  const t = useTranslations('TenantSwitcher')
  const router = useRouter()
  const [state, setState] = useState<SwitcherState | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  const refreshState = useCallback(async () => {
    const res = await getTenantSwitcherState()
    if (res.success) setState(res.data)
  }, [])

  useEffect(() => {
    let cancelled = false
    getTenantSwitcherState().then((res) => {
      if (!cancelled && res.success) setState(res.data)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!state) return null

  const active = state.tenants.find((t) => t.id === state.activeTenantId) ?? null
  const label = active?.displayName ?? (state.kind === 'platform' ? t('platform') : t('noTenant'))
  // A tenant selector only adds value when there is actually another tenant
  // to switch to. Keep the header quiet for the common single-tenant case.
  if (state.tenants.length < 2) return null

  const interactive = state.isSuperadmin || state.tenants.length > 1 || state.assumed

  const doSwitch = (tenantId: string) => {
    if (tenantId === state.activeTenantId && !state.assumed) {
      setOpen(false)
      return
    }
    startTransition(async () => {
      setOpen(false)
      const res = await switchTenant({ tenantId })
      if (res.success) {
        // A switcher saját state-jét a szerverről töltjük újra (az új cookie-t
        // olvasva) — a reload nem megbízhatóan frissítette a legördülő feliratot,
        // és a stale state miatt a visszaváltás no-op lett. A tartalmat a
        // router.refresh() (+ az action revalidatePath-je) frissíti.
        await refreshState()
        router.refresh()
      }
    })
  }

  const doExit = () => {
    startTransition(async () => {
      setOpen(false)
      const res = await exitTenant()
      if (res.success) {
        await refreshState()
        router.refresh()
      }
    })
  }

  if (!interactive) {
    return (
      <span className="hidden items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft sm:inline-flex">
        <span aria-hidden>🏢</span>
        <span className="max-w-[10rem] truncate">{label}</span>
      </span>
    )
  }

  return (
    <div className="relative hidden sm:block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={pending}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/45 hover:text-coral-deep disabled:opacity-60"
      >
        <span aria-hidden>{state.assumed ? '🕵️' : '🏢'}</span>
        <span className="max-w-[10rem] truncate">{label}</span>
        {state.assumed && (
          <span className="rounded-full bg-honey/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-honey">
            assumed
          </span>
        )}
        <svg aria-hidden viewBox="0 0 12 12" className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M2.5 4.5 6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <>
          <button type="button" aria-hidden tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-30 cursor-default" />
          <div role="menu" className="absolute right-0 top-full z-40 mt-2 min-w-[15rem] rounded-2xl border border-line bg-night/95 p-1.5 shadow-xl backdrop-blur-xl">
            <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
              {t('pick')}
            </p>
            {state.tenants.length === 0 && (
              <p className="px-3 py-2 text-xs text-ink-faint">{t('empty')}</p>
            )}
            {state.tenants.map((t) => {
              const isActive = t.id === state.activeTenantId && !state.assumed
              const isAssumedActive = t.id === state.activeTenantId && state.assumed
              return (
                <button
                  key={t.id}
                  type="button"
                  role="menuitem"
                  disabled={pending}
                  onClick={() => doSwitch(t.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-60 ${
                    isActive || isAssumedActive ? 'bg-coral/10 text-coral-deep' : 'text-ink-soft hover:bg-coral/8 hover:text-ink'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{t.displayName}</span>
                    <span className="block truncate text-[11px] text-ink-faint">{t.slug}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {!t.isMembership && state.isSuperadmin && (
                      <span className="rounded-full bg-honey/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-honey">
                        assume
                      </span>
                    )}
                    {t.status !== 'active' && (
                      <span className={`text-[10px] font-bold uppercase ${statusTone[t.status] ?? 'text-ink-faint'}`}>
                        {t.status}
                      </span>
                    )}
                    {(isActive || isAssumedActive) && <span aria-hidden className="text-coral">✓</span>}
                  </span>
                </button>
              )
            })}

            {(state.assumed || state.kind === 'platform') && state.isSuperadmin && (
              <>
                <div className="my-1 border-t border-line/60" />
                <button
                  type="button"
                  role="menuitem"
                  disabled={pending}
                  onClick={doExit}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-ink-soft transition-colors hover:bg-coral/8 hover:text-ink disabled:opacity-60"
                >
                  {t('exitPlatform')}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

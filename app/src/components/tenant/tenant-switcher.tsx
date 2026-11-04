'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { getTenantSwitcherState, switchTenant, exitTenant } from '@/app/actions/tenant'

/**
 * Fejléc tenant-switcher (Tenant-Management §9.1). Kiváltja a hardcode-olt
 * `OSTOROSBOR` feliratot: az aktív tenant nevét mutatja, és — több tenant vagy
 * superadmin esetén — legördülőből lehet váltani. A superadmin "assumed"
 * kontextusát külön jelöli, és van "kilépés" (→ platform-mód) művelete.
 * #830 D9: „Új cég" (→ onboarding), ameddig a saját cég-limit engedi — ilyenkor
 * egyetlen cégnél is látszik a váltó.
 * Mobilon is látszik, hogy melyik cégben dolgozik a felhasználó: keskeny
 * kijelzőn csak ikon (a név a lenyílóban és a tooltipben), 400px felett ikon +
 * rövidített cégnév — így a fejléc gombjai nem csúsznak ki a képernyőről.
 */

/** Váltás / kilépés után az Áttekintésre töltjük újra az oldalt (a gyökér a
 *  kontextusnak megfelelő kezdőoldalra irányít), hogy ne csak a fejléc, hanem
 *  a teljes tartalom — a kliens-oldali állapottal együtt — az új céget mutassa. */
const AFTER_SWITCH_PATH = '/control-plane'

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
  canCreateCompany: boolean
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
  // A tenant selector only adds value when there is another tenant to switch
  // to, or a new company can be started. Otherwise keep the header quiet.
  if (state.tenants.length < 2 && !state.canCreateCompany) return null

  const interactive =
    state.isSuperadmin || state.tenants.length > 1 || state.assumed || state.canCreateCompany

  const doSwitch = (tenantId: string) => {
    if (tenantId === state.activeTenantId && !state.assumed) {
      setOpen(false)
      return
    }
    startTransition(async () => {
      setOpen(false)
      const res = await switchTenant({ tenantId })
      if (res.success) {
        // Teljes oldalbetöltés az Áttekintésre: a router.refresh() csak a
        // szerver-komponenseket frissítette, a kliens-oldalon már betöltött
        // adatok (listák, panelek) a régi cégé maradtak. A hard navigáció az új
        // cookie-val renderel, és a switcher is friss állapottal mountol.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- szándékos teljes újratöltés
        window.location.assign(AFTER_SWITCH_PATH)
      }
    })
  }

  const doExit = () => {
    startTransition(async () => {
      setOpen(false)
      const res = await exitTenant()
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- szándékos teljes újratöltés
      if (res.success) window.location.assign(AFTER_SWITCH_PATH)
    })
  }

  if (!interactive) {
    return (
      <span
        title={label}
        className="inline-flex items-center gap-1 rounded-full border border-line bg-card px-2 py-1.5 text-xs font-semibold text-ink-soft sm:gap-1.5 sm:px-3"
      >
        <span aria-hidden>🏢</span>
        <span className="hidden max-w-[4.5rem] truncate min-[400px]:inline sm:max-w-[10rem]">{label}</span>
      </span>
    )
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t('pick')}: ${label}`}
        title={label}
        disabled={pending}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-full border border-line bg-card px-2 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/45 hover:text-coral-deep disabled:opacity-60 sm:gap-1.5 sm:px-3"
      >
        <span aria-hidden>{pending ? '⏳' : state.assumed ? '🕵️' : '🏢'}</span>
        <span className="hidden max-w-[4.5rem] truncate min-[400px]:inline sm:max-w-[10rem]">{label}</span>
        {state.assumed && (
          <span className="hidden rounded-full bg-honey/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-honey sm:inline">
            assumed
          </span>
        )}
        <svg aria-hidden viewBox="0 0 12 12" className={`hidden h-2.5 w-2.5 transition-transform sm:block ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M2.5 4.5 6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <>
          <button type="button" aria-hidden tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-30 cursor-default" />
          <div role="menu" className="absolute right-0 top-full z-40 mt-2 w-max min-w-[15rem] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-line bg-night/95 p-1.5 shadow-xl backdrop-blur-xl">
            <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
              {t('pick')}
            </p>
            {/* Keskeny mobilon a fejléc csak ikont mutat — itt látszik az aktív cég neve. */}
            <p className="truncate px-3 pb-1.5 text-sm font-semibold text-ink min-[400px]:hidden">
              {state.assumed ? '🕵️ ' : '🏢 '}
              {label}
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

            {state.canCreateCompany && (
              <>
                <div className="my-1 border-t border-line/60" />
                <button
                  type="button"
                  role="menuitem"
                  disabled={pending}
                  onClick={() => {
                    setOpen(false)
                    router.push('/onboarding')
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-semibold text-coral-deep transition-colors hover:bg-coral/8 disabled:opacity-60"
                >
                  {t('newCompany')}
                </button>
              </>
            )}

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

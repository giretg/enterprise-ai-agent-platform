'use client'

/**
 * Menü-hozzáférés — szerepkörönkénti fejléc-menü kurálás (tenant admin).
 *
 * ÜZLETI JELENTÉS: a mátrix egy sora egy menüpont, egy oszlopa egy szerepkör. A
 * bepipált négyzet azt jelenti: „ez a szerepkör LÁTJA ezt a menüpontot". A pipa
 * levétele a menüből veszi ki — NEM zárja le az oldalt. Ezt a felület ki is mondja,
 * hogy senki ne tévessze össze a jogosultsággal.
 *
 * Két állapot nem szerkeszthető, és mindkettőt megindokoljuk a felületen:
 *   • „nincs joga" — a szerepkör amúgy sem éri el az oldalt (a menüpont magasabb
 *     szerepet kér), tehát nincs mit elrejteni előle;
 *   • „kötelező" — az adminisztrátor elől nem rejthető el ez a szerkesztő és a
 *     befoglaló Adminisztráció menü, különben a beállítás visszavonhatatlan lenne.
 */
import { useMemo, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import type { UserRole } from '@prisma/client'
import { setNavVisibility } from '@/app/actions/menu-access'
import { Badge, Card } from '@/components/ui/shell'
import {
  CONTROL_PLANE_NAV_CATALOG,
  type ControlPlaneNavCatalogEntry,
  type ControlPlaneNavCatalogGroup,
  type ControlPlaneNavCatalogLeaf,
} from '@/lib/control-plane-nav'
import { asTranslate } from '@/i18n/translate'
import { navMessageKey } from '@/lib/control-plane-nav-i18n'
import { hasMinimumRole } from '@/lib/iam-policy'
import {
  NAV_VISIBILITY_ROLES,
  emptyNavVisibilityPolicy,
  isNavKeyLockedFor,
  isNavVisibilityPolicyEmpty,
  type NavVisibilityPolicy,
} from '@/lib/nav-visibility'

const isGroup = (entry: ControlPlaneNavCatalogEntry): entry is ControlPlaneNavCatalogGroup =>
  'children' in entry

type Row = {
  key: string
  label: string
  depth: 0 | 1
  requires: ControlPlaneNavCatalogLeaf['requires']
  isGroup: boolean
  /** Csoport esetén a gyerekek kulcsai — a csoport elrejtése az egészet leveszi. */
  childKeys: string[]
}

function toRows(catalog: readonly ControlPlaneNavCatalogEntry[]): Row[] {
  const rows: Row[] = []
  for (const entry of catalog) {
    if (!isGroup(entry)) {
      rows.push({
        key: entry.key,
        label: entry.label,
        depth: 0,
        requires: entry.requires,
        isGroup: false,
        childKeys: [],
      })
      continue
    }
    rows.push({
      key: entry.key,
      label: entry.label,
      depth: 0,
      requires: undefined,
      isGroup: true,
      childKeys: entry.children.map((child) => child.key),
    })
    for (const child of entry.children) {
      rows.push({
        key: child.key,
        label: child.label,
        depth: 1,
        requires: child.requires,
        isGroup: false,
        childKeys: [],
      })
    }
  }
  return rows
}

type CellState =
  | { kind: 'editable'; visible: boolean }
  | { kind: 'no-role' }
  | { kind: 'locked' }

function cellState(row: Row, role: UserRole, policy: NavVisibilityPolicy): CellState {
  if (isNavKeyLockedFor(role, row.key)) return { kind: 'locked' }
  // A `platformRole` követelmény nem tenant-szerep kérdése: az ilyen menüpont a
  // platform-szerep birtokosának jelenik meg, a tenant-szerepe MELLETT. Ezért ezeknél
  // minden oszlop szerkeszthető marad.
  if (row.requires?.tenantRole && !hasMinimumRole(role, row.requires.tenantRole)) {
    return { kind: 'no-role' }
  }
  return { kind: 'editable', visible: !policy[role].includes(row.key) }
}

function togglePolicy(
  policy: NavVisibilityPolicy,
  role: UserRole,
  keys: string[],
  hidden: boolean,
): NavVisibilityPolicy {
  const next: NavVisibilityPolicy = {
    viewer: [...policy.viewer],
    operator: [...policy.operator],
    approver: [...policy.approver],
    admin: [...policy.admin],
  }
  const set = new Set(next[role])
  for (const key of keys) {
    if (isNavKeyLockedFor(role, key)) continue
    if (hidden) set.add(key)
    else set.delete(key)
  }
  next[role] = [...set].sort()
  return next
}

export function MenuAccessPanel({ initialPolicy }: { initialPolicy: NavVisibilityPolicy }) {
  const t = useTranslations('ControlPlane.menuAccess')
  const tNav = asTranslate(useTranslations('ControlPlane.nav'))
  const roleLabel = (role: UserRole) => t(`roles.${role}` as 'roles.admin')
  const itemLabel = (key: string) => tNav(navMessageKey(key))
  const [saved, setSaved] = useState<NavVisibilityPolicy>(initialPolicy)
  const [draft, setDraft] = useState<NavVisibilityPolicy>(initialPolicy)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const rows = useMemo(() => toRows(CONTROL_PLANE_NAV_CATALOG), [])
  const dirty = useMemo(
    () => NAV_VISIBILITY_ROLES.some((role) => draft[role].join('|') !== saved[role].join('|')),
    [draft, saved],
  )
  const hiddenCount = useMemo(
    () => NAV_VISIBILITY_ROLES.reduce((sum, role) => sum + draft[role].length, 0),
    [draft],
  )

  function toggle(row: Row, role: UserRole, nextVisible: boolean) {
    // A csoport a gyerekeivel együtt mozog: a felhasználó egy legördülőt lát, nem
    // egy kulcs-halmazt — a fejléc levétele az egész menüt veszi ki.
    const keys = row.isGroup ? [row.key, ...row.childKeys] : [row.key]
    setDraft((cur) => togglePolicy(cur, role, keys, !nextVisible))
    setMessage(null)
  }

  function save() {
    startTransition(async () => {
      const res = await setNavVisibility({ policy: draft })
      if (res.success) {
        setSaved(res.data.policy)
        setDraft(res.data.policy)
        setMessage({
          tone: 'ok',
          text: isNavVisibilityPolicyEmpty(res.data.policy)
            ? t('savedEmpty')
            : t('saved'),
        })
      } else {
        setMessage({ tone: 'error', text: res.error })
      }
    })
  }

  return (
    <Card title={t('cardTitle')}>
      <div className="space-y-5">
        <p className="text-sm text-ink-soft">{t('help')}</p>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="py-2 pr-4 font-semibold">{t('colItem')}</th>
                {NAV_VISIBILITY_ROLES.map((role) => (
                  <th key={role} className="w-28 px-2 py-2 text-center font-semibold">
                    {roleLabel(role)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b border-line/50">
                  <th
                    scope="row"
                    className={`py-2 pr-4 text-left font-normal ${
                      row.isGroup ? 'font-semibold text-ink' : 'text-ink-soft'
                    }`}
                  >
                    <span className={row.depth === 1 ? 'pl-5' : ''}>{itemLabel(row.key)}</span>
                    {row.requires?.platformRole ? (
                      <span className="ml-2 align-middle">
                        <Badge tone="neutral">{t('platformRole')}</Badge>
                      </span>
                    ) : null}
                  </th>
                  {NAV_VISIBILITY_ROLES.map((role) => {
                    const state = cellState(row, role, draft)
                    const cellId = `${row.key}--${role}`
                    if (state.kind !== 'editable') {
                      const text = state.kind === 'locked' ? t('locked') : t('noAccess')
                      const title =
                        state.kind === 'locked'
                          ? t('lockedTitle')
                          : t('noAccessTitle', { role: roleLabel(role) })
                      return (
                        <td key={role} className="px-2 py-2 text-center">
                          <span className="text-xs text-ink-faint" title={title}>
                            {text}
                          </span>
                        </td>
                      )
                    }
                    return (
                      <td key={role} className="px-2 py-2 text-center">
                        <label className="inline-flex cursor-pointer items-center gap-2" htmlFor={cellId}>
                          <input
                            id={cellId}
                            type="checkbox"
                            className="h-4 w-4 accent-coral"
                            checked={state.visible}
                            disabled={pending}
                            onChange={(e) => toggle(row, role, e.target.checked)}
                          />
                          <span className="sr-only">
                            {t('visibleFor', { item: itemLabel(row.key), role: roleLabel(role) })}
                          </span>
                        </label>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || pending}
            className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-50"
          >
            {pending ? 'Mentés…' : 'Mentés'}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(saved)
              setMessage(null)
            }}
            disabled={!dirty || pending}
            className="rounded-lg border border-line bg-panel px-4 py-2 text-sm font-medium text-ink transition hover:border-coral/50 disabled:opacity-50"
          >
            Elvetés
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(emptyNavVisibilityPolicy())
              setMessage(null)
            }}
            disabled={pending || hiddenCount === 0}
            className="rounded-lg border border-line bg-panel px-4 py-2 text-sm font-medium text-ink-soft transition hover:border-coral/50 disabled:opacity-50"
          >
            Minden menüpont visszakapcsolása
          </button>
          <span className="text-xs text-ink-faint">
            {hiddenCount === 0
              ? 'Jelenleg nincs elrejtett menüpont.'
              : `${hiddenCount} elrejtés van beállítva (szerepkörönként összesítve).`}
          </span>
        </div>

        {message ? (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              message.tone === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </Card>
  )
}

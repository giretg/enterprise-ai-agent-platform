'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentPlacementOverridesAction } from '@/app/actions/agent-placement'
import {
  PLACEMENT_OVERRIDE_MAX,
  PLACEMENT_ROW_KEYS,
  type PlacementOverrides,
  type PlacementRowKey,
} from '@/lib/agent-knowledge-placement'

/** Hétköznapi nyelven: mit ment a munkatárs, és alapból hova. */
const ROWS: Record<PlacementRowKey, { what: string; byDefault: string; example: string }> = {
  fact: {
    what: 'Cégre vonatkozó tény, döntés, hely (ami most igaz)',
    byDefault: 'a munkatárs memóriájába',
    example: 'Pl.: a tudásbázisba, „Tények” néven',
  },
  rule: {
    what: 'Működési szabály, eljárás („nálunk így csináljuk”)',
    byDefault: 'skill-javaslatként, jóváhagyásra',
    example: 'Pl.: skill-javaslatként, de csak a marketing-vezető hagyhatja jóvá',
  },
  reference: {
    what: 'Háttéranyag, szakmai dokumentum',
    byDefault: 'a tudásbázisba',
    example: 'Pl.: a „Szerződések” Drive-mappába',
  },
  plan: {
    what: 'Munkaterv, jegyzet, piszkozat',
    byDefault: 'munkafájlba',
    example: 'Pl.: munkafájlba, a „terv/” mappába',
  },
  deliverable: {
    what: 'Kész anyag emberek számára',
    byDefault: 'a munkatárs Drive-mappájába',
    example: 'Pl.: a Drive-ban a „Heti riportok” mappába',
  },
  session_log: {
    what: 'Mi történt ma',
    byDefault: 'munkanaplóba (session log)',
    example: 'Pl.: a munkafájlba, naplóként hozzáfűzve',
  },
  focus: {
    what: 'Min dolgozunk most',
    byDefault: 'a munkatárs fókuszába',
    example: 'Pl.: a „folyamatban.md” munkafájlba',
  },
  wiki: {
    what: 'Tanulandó, összekapcsolandó tudás',
    byDefault: 'a munkatárs wikijébe',
    example: 'Pl.: csak a wikibe, memóriába ne',
  },
}

/** A „hová mit ments” tábla agentenkénti felülírása — publikálás után lép életbe. */
export function UpdatePlacementOverridesForm({
  agentId,
  placementOverrides,
  canEdit,
}: {
  agentId: string
  placementOverrides: PlacementOverrides
  canEdit: boolean
}) {
  const router = useRouter()
  const [values, setValues] = useState<Record<string, string>>({ ...placementOverrides })
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        startTransition(async () => {
          setError(null)
          setDone(null)
          const res = await updateAgentPlacementOverridesAction({ agentId, rows: values })
          if (res.success) {
            setDone('Mentve. A munkatárs a következő publikálás után követi (Élesítés → Publikálás).')
            router.refresh()
          } else {
            setError(res.error)
          }
        })
      }}
    >
      <p className="text-sm text-ink-soft">
        Ha a munkatársnak valamit a megszokottól eltérő helyre kell mentenie, írd be a megfelelő sorba. Amit üresen
        hagysz, ott a platform alapszabálya érvényes: a tényeket a munkatárs memóriája kapja, a szabályok skillként,
        a háttéranyagok a tudásbázisba kerülnek.
      </p>
      <ul className="space-y-3">
        {PLACEMENT_ROW_KEYS.map((key) => {
          const row = ROWS[key]
          return (
            <li key={key} className="space-y-1">
              <label htmlFor={`placement-${key}`} className="block text-sm font-medium text-ink">
                {row.what}
              </label>
              {canEdit ? (
                <input
                  id={`placement-${key}`}
                  value={values[key] ?? ''}
                  maxLength={PLACEMENT_OVERRIDE_MAX}
                  onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
                  placeholder={`Alapból: ${row.byDefault}. ${row.example}`}
                  className="w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
                />
              ) : (
                <p className="text-sm text-ink-soft">{values[key]?.trim() || `Alapból: ${row.byDefault}`}</p>
              )}
            </li>
          )
        })}
      </ul>
      {error ? <p className="text-sm text-coral">{error}</p> : null}
      {done ? <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">{done}</p> : null}
      {canEdit ? (
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
        >
          {pending ? 'Mentés…' : 'Mentés'}
        </button>
      ) : null}
    </form>
  )
}

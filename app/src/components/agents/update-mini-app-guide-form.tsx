'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentMiniAppGuideAction } from '@/app/actions/mini-apps'
import { miniAppLintLabel } from '@/domain/mini-app/lint-labels'

const GUIDE_MAX = 8000

const EXAMPLE = `Céges színek: #0B3D2E (sötétzöld) és #F2C14E (sárga), háttér fehér.
Minden riport elején legyen egy 3 mondatos vezetői összefoglaló.
Táblázatoknál legyen összesítő sor, a számok jobbra igazítva, ezres tagolással.
A végén egy rövid „Adatforrás és időszak” bekezdés.`

/** Kliens-oldali előjelzés ugyanarra, amit a szerver `guideConflicts` jelez. */
function conflictsOf(text: string): string[] {
  const found: string[] = []
  if (/<script[^>]*\ssrc\s*=/i.test(text)) found.push('external_script')
  if (/https?:\/\/\S+\.(css|js|woff2?|ttf)\b|fonts\.googleapis|cdn\.jsdelivr|unpkg\.com/i.test(text)) found.push('external_resource')
  if (/\bfetch\s*\(/.test(text)) found.push('fetch_call')
  if (/<(iframe|form|object|embed)[\s>]/i.test(text)) found.push('iframe_tag')
  return found
}

/** #967 D12: az agent mini app útmutatója — publikálás után lép életbe. */
export function UpdateMiniAppGuideForm({
  agentId,
  miniAppGuide,
  canEdit,
}: {
  agentId: string
  miniAppGuide: string
  canEdit: boolean
}) {
  const router = useRouter()
  const [value, setValue] = useState(miniAppGuide)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const conflicts = conflictsOf(value)

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim() === miniAppGuide.trim()) {
          setError('Nincs változás.')
          return
        }
        startTransition(async () => {
          setError(null)
          setDone(null)
          const res = await updateAgentMiniAppGuideAction({ agentId, guide: value })
          if (res.success) {
            setDone('Mentve. A munkatárs a következő publikálás után kapja meg (Élesítés → Publikálás).')
            router.refresh()
          } else {
            setError(res.error)
          }
        })
      }}
    >
      <p className="text-sm text-ink-soft">
        Itt leírhatod, hogyan készítse ez a munkatárs a mini appokat — pl. színek, felépítés, kötelező részek. Nem
        kötelező. A munkatárs minden mini app előtt megkapja, a publikálás után lép életbe.
      </p>
      {canEdit ? (
        <>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={6}
            maxLength={GUIDE_MAX}
            placeholder="Nincs megadva — a munkatárs csak a platform alapszabályait követi (egyetlen HTML-fájl, beágyazott adat, nincs internet-elérés)."
            className="w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-soft">
            <span>
              {value.length} / {GUIDE_MAX} karakter
            </span>
            {!value.trim() ? (
              <button type="button" className="text-coral-deep underline" onClick={() => setValue(EXAMPLE)}>
                Példa beillesztése
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="whitespace-pre-wrap text-sm text-ink">
          {miniAppGuide.trim() ||
            'Nincs megadva — a munkatárs csak a platform alapszabályait követi (egyetlen HTML-fájl, beágyazott adat, nincs internet-elérés).'}
        </p>
      )}
      {conflicts.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-honey">
          {conflicts.map((code) => (
            <li key={code}>{miniAppLintLabel(code)}</li>
          ))}
        </ul>
      ) : null}
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

'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentSensitivityPolicy } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

// Sensitivity router per-agent felmentése (§4.7.2). A kategória-policy
// szerkesztő (APG-14, PrivacyAdminPanel) váltotta fel a fő felületeken.
export function SensitivityPolicyForm({
  agentId,
  allowSensitiveExternalModel,
  canEdit = true,
}: {
  agentId: string
  allowSensitiveExternalModel: boolean
  /** Operátor csak a jelenlegi szabályt látja; az admin ugyanitt kapcsolja. */
  canEdit?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [allowed, setAllowed] = useState(allowSensitiveExternalModel)

  const submit = (next: boolean) => {
    startTransition(async () => {
      setError(null)
      const res = await updateAgentSensitivityPolicy({
        agentId,
        allowSensitiveExternalModel: next,
      })
      if (res.success) {
        setAllowed(next)
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <Card title="Érzékeny tartalom kezelése">
      <p className="mb-4 text-xs text-ink-faint">
        A platform minden modellhívás előtt megvizsgálja a promptot. Ha{' '}
        <strong>érzékeny</strong> adatot talál (email-cím, TAJ-szám, adószám), a hívást
        helyi modellre tereli. Ahol nincs telepítve helyi modell, ott a hívás blokkolódik.
        Egy email-lel dolgozó agent enélkül a felmentés nélkül nem tud működni.
        A kapcsoló a kategória-policyre képződik le; kategóriánkénti szerkesztő később jön.
      </p>

      {canEdit ? (
        <>
          <label className="flex items-start gap-3 rounded-lg border border-line bg-night-2 px-3 py-3 text-sm">
            <input
              type="checkbox"
              checked={allowed}
              disabled={pending}
              onChange={(e) => submit(e.currentTarget.checked)}
              className="mt-1"
            />
            <span>
              <span className="text-ink-soft">Érzékeny tartalom külső modellnek is küldhető</span>
              <span className="mt-1 block text-xs text-ink-faint">
                Bekapcsolva a platform érzékenységi ellenőrzése semmilyen tartalom miatt nem
                blokkolja vagy tereli helyi modellre ezt az agentet. Minden ilyen hívás auditba
                kerül.
              </span>
            </span>
          </label>

          <p className="mt-3 rounded-lg border border-line bg-night-2 px-3 py-2 text-xs text-ink-faint">
            Ideiglenes teljes felmentés: bankkártyaszám, IBAN és privát kulcs vagy API-token
            észlelésekor is átengedi a modellhívást. Az észlelés auditálása aktív marad.
          </p>

          {error && <p className="mt-3 text-sm text-coral">{error}</p>}
          {pending && <p className="mt-3 text-xs text-ink-faint">Mentés...</p>}
        </>
      ) : (
        <p className="text-sm leading-relaxed text-ink">
          {allowed
            ? 'Érzékeny tartalom külső modellnek is küldhető. Minden ilyen hívás auditba kerül.'
            : 'Érzékeny tartalomnál a platform helyi modellre terel, vagy blokkol, ha nincs helyi modell.'}
        </p>
      )}
    </Card>
  )
}

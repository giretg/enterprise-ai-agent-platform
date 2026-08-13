'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentTaskOnly } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

// Feladatkör-korlátozás (#199). Bekapcsolva az agent felületén nincs chat, csak
// egyetlen skill-kötött feladat-indító gomb. A magyarázó szöveg SZÁNDÉKOSAN
// mondja ki, mit NEM garantál: ez a felületet egyszerűsíti, nem az agent
// jogosultságait szűkíti — különben később valaki compliance-garanciaként
// hivatkozna rá.
export function TaskOnlyForm({
  agentId,
  taskOnly,
  canEdit = true,
}: {
  agentId: string
  taskOnly: boolean
  /** Operátor csak a jelenlegi módot látja; az admin ugyanitt kapcsolja. */
  canEdit?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [restricted, setRestricted] = useState(taskOnly)

  const submit = (next: boolean) => {
    startTransition(async () => {
      setError(null)
      const res = await updateAgentTaskOnly({ agentId, taskOnly: next })
      if (res.success) {
        setRestricted(next)
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <Card title="Feladatkör-korlátozás">
      <p className="mb-4 text-xs text-ink-faint">
        {canEdit
          ? 'Ha az agent egyetlen jól körülhatárolt célt szolgál, itt leegyszerűsítheted a felületét: eltűnik a chat, és egyetlen gomb marad, ami egy előre kiválasztott skillhez kötött feladatot indít — szabad szöveges feladatleírás nélkül.'
          : 'Ha az agent egyetlen jól körülhatárolt célt szolgál, a felülete leegyszerűsödik: nincs szabad chat, csak egy előre kiválasztott skillhez kötött feladat-indító gomb.'}
      </p>

      {canEdit ? (
        <>
          <label className="flex items-start gap-3 rounded-lg border border-line bg-night-2 px-3 py-3 text-sm">
            <input
              type="checkbox"
              checked={restricted}
              disabled={pending}
              onChange={(e) => submit(e.currentTarget.checked)}
              className="mt-1"
            />
            <span>
              <span className="text-ink-soft">Csak skill-kötött feladat indítható</span>
              <span className="mt-1 block text-xs text-ink-faint">
                A feladat bemenete legfeljebb a skill paraméterei és — ha a skill engedi —
                a csatolt fájlok. A ticket címét a rendszer generálja.
              </span>
            </span>
          </label>

          <div className="mt-3 rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-xs text-ink-soft">
            <p className="font-medium text-honey">
              Ez a felületet egyszerűsíti, nem a jogokat szűkíti.
            </p>
            <p className="mt-1">
              Az agent képességei változatlanok: amit egyébként megtehet, azt korlátozott
              módban is megteheti. A nem-emberi belépési pontok — másik agent kérdése
              (agent_ask), csatorna-integrációk (pl. Telegram), agent API-kulcs,
              monitor-eszkaláció és a ticket-kommentek — nyitva maradnak. Ha valamit
              tényleg tiltani kell, azt a capability-grantoknál vedd el.
            </p>
          </div>

          {error && <p className="mt-3 text-sm text-coral">{error}</p>}
          {pending && <p className="mt-3 text-xs text-ink-faint">Mentés...</p>}
        </>
      ) : (
        <p className="text-sm leading-relaxed text-ink">
          {restricted
            ? 'Csak skill-kötött feladat indítható — nincs szabad chat.'
            : 'Teljes chat elérhető, nem csak egyetlen előre kötött feladat.'}
        </p>
      )}
    </Card>
  )
}

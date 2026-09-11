'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentOperatorSkillManagement } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

// Agent-szintű delegálás: az operátor is hozzárendelhet / levehet / ki-bekapcsolhat
// skillt ezen az agenten. A skill tartalmát és a jóváhagyást nem érinti.
export function OperatorSkillManagementForm({
  agentId,
  operatorCanManageSkills,
  canEdit = true,
}: {
  agentId: string
  operatorCanManageSkills: boolean
  canEdit?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [allowed, setAllowed] = useState(operatorCanManageSkills)

  const submit = (next: boolean) => {
    startTransition(async () => {
      setError(null)
      const res = await updateAgentOperatorSkillManagement({
        agentId,
        operatorCanManageSkills: next,
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
    <Card title="Munkamenetek kezelése operátorként">
      <p className="mb-4 text-xs text-ink-faint">
        Alapból csak admin döntheti el, melyik képesség (skill) tartozik ehhez az
        agenthez. Ezzel a kapcsolóval ezt a döntést átadod az operátoroknak is — de csak
        EZEN az agenten, és csak a már jóváhagyott képességek közül választhatnak.
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
              <span className="text-ink-soft">
                Az operátor is hozzárendelhet és levehet képességet
              </span>
              <span className="mt-1 block text-xs text-ink-faint">
                Amit ez NEM ad: képesség-szöveg szerkesztése, új verzió jóváhagyása, új
                eszközjog. Minden hozzárendelés ugyanúgy auditált marad.
              </span>
            </span>
          </label>

          {error && <p className="mt-3 text-sm text-coral">{error}</p>}
          {pending && <p className="mt-3 text-xs text-ink-faint">Mentés...</p>}
        </>
      ) : (
        <p className="text-sm leading-relaxed text-ink">
          {allowed
            ? 'Az operátorok is hozzárendelhetnek és levehetnek képességet ezen az agenten.'
            : 'A képesség-hozzárendelés ezen az agenten admin-döntés.'}
        </p>
      )}
    </Card>
  )
}

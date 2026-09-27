'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import {
  listApproverCandidates,
  updateAgentApprover,
  updateConnectorApprover,
} from '@/app/actions/platform'

type Candidate = { id: string; name: string; email: string; role: string | null }

/**
 * #663: megnevezett jóváhagyó választása a tenant tagjai közül, agenthez vagy
 * konnektorhoz. A megnevezett a saját kérését is jóváhagyhatja; mindenki másnak
 * az írása nála landol a jóváhagyási sorban.
 */
export function UpdateApproverForm({
  entity,
  currentApproverUserId,
  canEdit = true,
}: {
  entity: { kind: 'agent'; agentId: string } | { kind: 'connector'; connectorId: string }
  currentApproverUserId: string | null
  canEdit?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [selected, setSelected] = useState<string>(currentApproverUserId ?? '')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    if (!canEdit) return
    let live = true
    void listApproverCandidates().then((res) => {
      if (live && res.success) setCandidates(res.data.users)
    })
    return () => {
      live = false
    }
  }, [canEdit])

  const currentName = candidates?.find((c) => c.id === currentApproverUserId)?.name
  if (!canEdit) {
    return (
      <p className="text-sm text-ink-soft">
        {currentApproverUserId
          ? `Megnevezett jóváhagyó: ${currentName ?? 'betöltés…'}. Az ő jóváhagyása kell az írásokhoz; a saját kérését is jóváhagyhatja.`
          : 'Nincs megnevezett jóváhagyó — az írások az általános jóváhagyási sorba kerülnek.'}
      </p>
    )
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        const next = selected || null
        if ((next ?? null) === (currentApproverUserId ?? null)) {
          setError('Nincs változás')
          return
        }
        startTransition(async () => {
          setError(null)
          setDone(null)
          const res =
            entity.kind === 'agent'
              ? await updateAgentApprover({ agentId: entity.agentId, approverUserId: next })
              : await updateConnectorApprover({
                  connectorId: entity.connectorId,
                  approverUserId: next,
                })
          if (res.success) {
            setDone(
              next
                ? 'Mentve. A következő írás már a megnevezett jóváhagyóhoz kerül.'
                : 'Törölve. Az írások újra az általános jóváhagyási sorba kerülnek.',
            )
            router.refresh()
          } else {
            setError(res.error)
          }
        })
      }}
    >
      <label className="block text-sm text-ink-soft">
        Ki hagyhatja jóvá az írásokat
        <select
          className="mt-1 w-full rounded-md border border-ink/15 bg-white px-2 py-1.5 text-sm text-ink"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={pending || candidates === null}
        >
          <option value="">Nincs megnevezett — általános sor</option>
          {(candidates ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.email} ({c.role})
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-ink-soft">
        A megnevezett jóváhagyó a saját kérését is jóváhagyhatja. Másnak az írása csak nála (vagy
        egy adminnál) mehet át.
      </p>
      {error && <p className="text-sm text-coral">{error}</p>}
      {done && (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
          {done}
        </p>
      )}
      <button
        type="submit"
        disabled={pending || candidates === null}
        className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
      >
        {pending ? 'Mentés…' : 'Mentés'}
      </button>
    </form>
  )
}

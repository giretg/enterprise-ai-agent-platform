'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import {
  listApproverCandidates,
  updateAgentApprover,
  updateAgentMemoryWriteMode,
} from '@/app/actions/platform'
import type { MemoryWriteMode } from '@prisma/client'

type Candidate = { id: string; name: string; email: string; role: string | null }

/** Projektmemória írása: jóváhagyás (alap) vagy közvetlen. Jóváhagyás módban megnevezett jóváhagyó. */
export function UpdateMemoryWriteModeForm({
  agentId,
  memoryWriteMode,
  approverUserId,
  canEdit = true,
}: {
  agentId: string
  memoryWriteMode: MemoryWriteMode
  approverUserId: string | null
  canEdit?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [mode, setMode] = useState<MemoryWriteMode>(memoryWriteMode)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [approver, setApprover] = useState(approverUserId ?? '')

  useEffect(() => {
    setMode(memoryWriteMode)
    setApprover(approverUserId ?? '')
  }, [memoryWriteMode, approverUserId])

  useEffect(() => {
    if (!canEdit || mode !== 'approval') return
    let live = true
    void listApproverCandidates().then((res) => {
      if (live && res.success) setCandidates(res.data.users)
    })
    return () => {
      live = false
    }
  }, [canEdit, mode])

  if (!canEdit) {
    return (
      <div className="space-y-2 text-sm text-ink-soft">
        <p>
          {memoryWriteMode === 'direct'
            ? 'Közvetlen írás — az agent a projektmemóriát jóváhagyás nélkül írja. A betanított szabályt továbbra sem változtathatja egyedül.'
            : 'Jóváhagyás — az agent javasol, egy ember fogadja el. Ez az alapértelmezés.'}
        </p>
        {memoryWriteMode === 'approval' && approverUserId ? (
          <p>
            Megnevezett jóváhagyó:{' '}
            {candidates?.find((c) => c.id === approverUserId)?.name ?? '…'} — a memóriaírások és a
            kimenő eszközműveletek (pl. API, Drive) jóváhagyása elsősorban hozzá kerül.
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        const modeChanged = mode !== memoryWriteMode
        const approverNext = mode === 'approval' ? approver || null : approverUserId
        const approverChanged =
          mode === 'approval' && (approverNext ?? null) !== (approverUserId ?? null)
        if (!modeChanged && !approverChanged) {
          setError('Nincs változás')
          return
        }
        startTransition(async () => {
          setError(null)
          setDone(null)
          if (modeChanged) {
            const res = await updateAgentMemoryWriteMode({ agentId, memoryWriteMode: mode })
            if (!res.success) {
              setError(res.error)
              return
            }
          }
          if (approverChanged) {
            const res = await updateAgentApprover({ agentId, approverUserId: approverNext })
            if (!res.success) {
              setError(res.error)
              return
            }
          }
          setDone('Mentve.')
          router.refresh()
        })
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm text-ink-soft">Hogyan írja az agent a projektmemóriát</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="memoryWriteMode"
            value="approval"
            checked={mode === 'approval'}
            onChange={() => setMode('approval')}
          />
          <span>
            <span className="font-medium">Jóváhagyás</span> — az agent javasol, egy ember elfogadja.
            Alapértelmezés.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="memoryWriteMode"
            value="direct"
            checked={mode === 'direct'}
            onChange={() => setMode('direct')}
          />
          <span>
            <span className="font-medium">Közvetlen írás</span> — azonnal bekerül, verzióval és naplóval.
            A betanított működési szabályt ez nem nyitja ki.
          </span>
        </label>
      </fieldset>

      {mode === 'approval' ? (
        <div className="space-y-2 rounded-lg border border-line/60 bg-paper/80 px-3 py-3">
          <label className="block text-sm text-ink-soft">
            Ki hagyja jóvá a memóriaírásokat
            <select
              className="mt-1 w-full rounded-md border border-ink/15 bg-white px-2 py-1.5 text-sm text-ink"
              value={approver}
              onChange={(event) => setApprover(event.target.value)}
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
            A megnevezett jóváhagyó a saját memória- és eszközkérését is jóváhagyhatja. Másnak az írása
            csak nála (vagy egy adminnál) mehet át. A kimenő kapcsolatok (pl. blog API) jóváhagyását
            később konnektoronként is lehet szűkíteni.
          </p>
        </div>
      ) : null}

      {error && <p className="text-sm text-coral">{error}</p>}
      {done && (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">{done}</p>
      )}
      <button
        type="submit"
        disabled={pending || (mode === 'approval' && candidates === null)}
        className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
      >
        {pending ? 'Mentés…' : 'Mentés'}
      </button>
    </form>
  )
}

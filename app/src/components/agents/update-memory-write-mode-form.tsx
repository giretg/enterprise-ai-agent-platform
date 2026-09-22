'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentMemoryWriteMode } from '@/app/actions/platform'
import type { MemoryWriteMode } from '@prisma/client'

/** Projektmemória írása: jóváhagyás (alap) vagy közvetlen. A betanított szabályt nem nyitja ki. */
export function UpdateMemoryWriteModeForm({
  agentId,
  memoryWriteMode,
  canEdit = true,
}: {
  agentId: string
  memoryWriteMode: MemoryWriteMode
  canEdit?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  if (!canEdit) {
    return (
      <p className="text-sm text-ink-soft">
        {memoryWriteMode === 'direct'
          ? 'Közvetlen írás — az agent a projektmemóriát jóváhagyás nélkül írja. A betanított szabályt továbbra sem változtathatja egyedül.'
          : 'Jóváhagyás — az agent javasol, egy ember fogadja el. Ez az alapértelmezés.'}
      </p>
    )
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        const fd = new FormData(e.currentTarget)
        const next = String(fd.get('memoryWriteMode')) as MemoryWriteMode
        if (next === memoryWriteMode) {
          setError('Nincs változás')
          return
        }
        startTransition(async () => {
          setError(null)
          setDone(null)
          const res = await updateAgentMemoryWriteMode({ agentId, memoryWriteMode: next })
          if (res.success) {
            setDone('Mentve. Az MCP a következő memóriaírásnál ezt a módot használja.')
            router.refresh()
          } else {
            setError(res.error)
          }
        })
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm text-ink-soft">Hogyan írja az agent a projektmemóriát</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="memoryWriteMode" value="approval" defaultChecked={memoryWriteMode === 'approval'} />
          <span>
            <span className="font-medium">Jóváhagyás</span> — az agent javasol, egy ember elfogadja. Alapértelmezés.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="memoryWriteMode" value="direct" defaultChecked={memoryWriteMode === 'direct'} />
          <span>
            <span className="font-medium">Közvetlen írás</span> — azonnal bekerül, verzióval és naplóval. A betanított működési szabályt ez nem nyitja ki.
          </span>
        </label>
      </fieldset>
      {error && <p className="text-sm text-coral">{error}</p>}
      {done && (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">{done}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
      >
        {pending ? 'Mentés...' : 'Mentés'}
      </button>
    </form>
  )
}

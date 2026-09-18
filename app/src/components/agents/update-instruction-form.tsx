'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentInstruction } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

// Admin frissítheti a szerep-instrukciót (§5.3). A munkastílust ("hogyan") külön,
// a "Munkastílus" doboz kezeli (központi profil + egyedi rész). Csak a ténylegesen
// változó mező al-verziója lép, és új agent-verzió fagy be.
export function UpdateInstructionForm({
  agentId,
  roleInstruction,
  roleVersion: _roleVersion,
  bare = false,
}: {
  agentId: string
  roleInstruction: string
  roleVersion?: number
  /** A hívó már adott keretet (címsor + doboz) — ne rajzoljunk másodikat. */
  bare?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const form = (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        const fd = new FormData(e.currentTarget)
        const nextRole = String(fd.get('roleInstruction'))
        if (nextRole === roleInstruction) {
          setError('Nincs változás a munkaköri leírásban')
          return
        }
        startTransition(async () => {
          setError(null)
          setDone(null)
          const res = await updateAgentInstruction({ agentId, roleInstruction: nextRole })
          if (res.success) {
            setDone('Munkakör frissítve')
            router.refresh()
          } else {
            setError(res.error)
          }
        })
      }}
    >
      <label className="block text-sm">
        <span className="text-ink-soft">Munkaköri leírás</span>
        <textarea
          name="roleInstruction"
          defaultValue={roleInstruction}
          rows={10}
          className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
        />
      </label>
      {error && <p className="text-sm text-coral">{error}</p>}
      {done && (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
          Mentve: {done}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
      >
        {pending ? 'Mentés...' : 'Új verzió mentése'}
      </button>
    </form>
  )

  if (bare) return form
  return <Card title="Munkaköri leírás szerkesztése">{form}</Card>
}

'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentInstruction } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

// Admin frissítheti a szerep-instrukciót és/vagy a viselkedés-profilt (§5.3).
// Csak a ténylegesen változó mező al-verziója lép, és új agent-verzió fagy be.
export function UpdateInstructionForm({
  agentId,
  roleInstruction,
  behaviorProfile,
  roleVersion,
  behaviorVersion,
}: {
  agentId: string
  roleInstruction: string
  behaviorProfile: string
  roleVersion: number
  behaviorVersion: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  return (
    <Card title="Instrukció frissítése (admin)">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          const fd = new FormData(e.currentTarget)
          const nextRole = String(fd.get('roleInstruction'))
          const nextBehavior = String(fd.get('behaviorProfile'))
          startTransition(async () => {
            setError(null)
            setDone(null)
            const res = await updateAgentInstruction({
              agentId,
              ...(nextRole !== roleInstruction ? { roleInstruction: nextRole } : {}),
              ...(nextBehavior !== behaviorProfile ? { behaviorProfile: nextBehavior } : {}),
            })
            if (res.success) {
              const changed = [
                res.data.roleChanged ? `szerep → v${res.data.roleInstructionVersion}` : null,
                res.data.behaviorChanged
                  ? `viselkedés → v${res.data.behaviorProfileVersion}`
                  : null,
              ]
                .filter(Boolean)
                .join(', ')
              setDone(`Agent v${res.data.agentVersion} (${changed})`)
              router.refresh()
            } else {
              setError(res.error)
            }
          })
        }}
      >
        <label className="block text-sm">
          <span className="text-ink-soft">Szerep-instrukció (jelenleg v{roleVersion})</span>
          <textarea
            name="roleInstruction"
            defaultValue={roleInstruction}
            rows={3}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-ink-soft">Viselkedés-profil (jelenleg v{behaviorVersion})</span>
          <textarea
            name="behaviorProfile"
            defaultValue={behaviorProfile}
            rows={5}
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
    </Card>
  )
}

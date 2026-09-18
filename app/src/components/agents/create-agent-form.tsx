'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { createAgent } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

export function CreateAgentForm() {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [roleInstruction, setRoleInstruction] = useState('')

  return (
    <Card title="Alapok">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          start(async () => {
            const result = await createAgent({ name, roleInstruction })
            if (!result.success) {
              setError(result.error)
              return
            }
            router.push(`/control-plane/agents/${result.data.agent.id}`)
          })
        }}
      >
        <label className="block text-sm">
          Név
          <input
            className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="block text-sm">
          Munkakör
          <textarea
            className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2"
            rows={6}
            value={roleInstruction}
            onChange={(e) => setRoleInstruction(e.target.value)}
            required
          />
        </label>
        {error ? <p className="text-sm text-coral-deep">{error}</p> : null}
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {pending ? 'Mentés…' : 'Létrehozás'}
        </button>
      </form>
    </Card>
  )
}

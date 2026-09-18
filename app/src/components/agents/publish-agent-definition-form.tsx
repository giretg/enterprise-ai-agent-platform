'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { publishAgentDefinitionAction } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

export function PublishAgentDefinitionForm({
  agentId,
  currentDefinitionId,
}: {
  agentId: string
  currentDefinitionId: string | null
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <Card title="Published definition">
      <p className="text-sm text-ink-soft">
        Jelenlegi verzió:{' '}
        <code className="text-xs">{currentDefinitionId ?? 'még nincs publikálva'}</code>
      </p>
      <button
        type="button"
        disabled={pending}
        className="mt-3 rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        onClick={() => {
          start(async () => {
            const result = await publishAgentDefinitionAction({ agentId })
            if (!result.success) {
              setError(result.error)
              return
            }
            setError(null)
            router.refresh()
          })
        }}
      >
        {pending ? 'Publikálás…' : 'Publish'}
      </button>
      {error ? <p className="mt-2 text-sm text-coral-deep">{error}</p> : null}
    </Card>
  )
}

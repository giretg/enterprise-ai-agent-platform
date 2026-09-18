'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentConnectorBinding } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

type Binding = {
  connector: { id: string; name: string; type: string }
  accessMode: 'read' | 'write'
}

export function AgentConnectorBindingForm({
  agentId,
  bindings,
}: {
  agentId: string
  bindings: Binding[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [connectorId, setConnectorId] = useState('')
  const [accessMode, setAccessMode] = useState<'read' | 'write'>('read')

  return (
    <Card title="Konnektorok">
      {bindings.length === 0 ? (
        <p className="text-sm text-ink-soft">Nincs kötött konnektor.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {bindings.map((row) => (
            <li key={row.connector.id}>
              {row.connector.name} ({row.connector.type}) — {row.accessMode}
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          start(async () => {
            const result = await updateAgentConnectorBinding({
              agentId,
              connectorId,
              accessMode,
            })
            if (!result.success) {
              setError(result.error)
              return
            }
            setError(null)
            setConnectorId('')
            router.refresh()
          })
        }}
      >
        <label className="text-sm">
          Connector ID
          <input
            className="mt-1 block rounded-lg border border-line bg-paper px-3 py-2"
            value={connectorId}
            onChange={(e) => setConnectorId(e.target.value)}
            required
          />
        </label>
        <label className="text-sm">
          Mód
          <select
            className="mt-1 block rounded-lg border border-line bg-paper px-3 py-2"
            value={accessMode}
            onChange={(e) => setAccessMode(e.target.value as 'read' | 'write')}
          >
            <option value="read">read</option>
            <option value="write">write</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {pending ? 'Mentés…' : 'Kötés'}
        </button>
      </form>
      {error ? <p className="mt-2 text-sm text-coral-deep">{error}</p> : null}
    </Card>
  )
}

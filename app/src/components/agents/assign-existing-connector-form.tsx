'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import { assignConnectorToAgent } from '@/app/actions/provisioning'
import { Card } from '@/components/ui/shell'

type ConnectorOption = {
  id: string
  type: string
  name: string
}

const INPUT = 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'

export function AssignExistingConnectorForm({
  agentId,
  connectors,
  bare = false,
}: {
  agentId: string
  connectors: ConnectorOption[]
  bare?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [connectorId, setConnectorId] = useState(connectors[0]?.id ?? '')
  const [accessMode, setAccessMode] = useState<'read' | 'write'>('read')
  const [apiKey, setApiKey] = useState('')

  const selected = useMemo(
    () => connectors.find((connector) => connector.id === connectorId),
    [connectorId, connectors],
  )

  function submit() {
    startTransition(async () => {
      setError(null)
      setDone(null)

      const res = await assignConnectorToAgent({
        agentId,
        connectorId,
        accessMode,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })

      if (res.success) {
        setDone(selected ? `„${selected.name}" hozzárendelve.` : 'Kapcsolat hozzárendelve.')
        setApiKey('')
        router.refresh()
      } else {
        setError(res.error ?? 'Nem sikerült hozzárendelni a kapcsolatot.')
      }
    })
  }

  const form = (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
        {connectors.length === 0 ? (
          <p className="text-sm text-ink-faint">Nincs aktivált provisioning-kapcsolat.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-ink-soft">Kapcsolat</span>
                <select
                  value={connectorId}
                  onChange={(e) => setConnectorId(e.target.value)}
                  className={INPUT}
                >
                  {connectors.map((connector) => (
                    <option key={connector.id} value={connector.id}>
                      {connector.name} · {connector.type}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">Hozzáférés</span>
                <select
                  value={accessMode}
                  onChange={(e) => setAccessMode(e.target.value as 'read' | 'write')}
                  className={INPUT}
                >
                  <option value="read">Csak olvasás</option>
                  <option value="write">Olvasás + írás</option>
                </select>
              </label>
            </div>

            {selected?.type !== 'gmail' ? (
              <label className="block text-sm">
                <span className="text-ink-soft">Per-agent API kulcs</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Üresen hagyva a kapcsolat megosztott kulcsát használja"
                  autoComplete="off"
                  className={INPUT}
                />
              </label>
            ) : null}

            {error && <p className="text-sm text-coral">{error}</p>}
            {done && <p className="text-sm text-sage">{done}</p>}

            <button
              type="submit"
              disabled={pending || !connectorId}
              className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
            >
              {pending ? 'Hozzárendelés...' : 'Hozzárendelés'}
            </button>
          </>
        )}
      </form>
  )

  if (bare) return form
  return <Card title="Meglévő kapcsolat hozzárendelése">{form}</Card>
}

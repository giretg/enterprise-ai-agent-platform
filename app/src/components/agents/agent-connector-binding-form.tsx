'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  assignConnectorToAgent,
  unassignConnectorFromAgent,
} from '@/app/actions/provisioning'
import { Card } from '@/components/ui/shell'
import { OpenInNewWindowLink } from '@/components/ui/open-in-new-window-link'
import {
  CREATE_AGENT_WIZARD_EXTERNAL_HREFS,
  matchAssignableConnectorsByName,
} from '@/lib/create-agent-wizard'

export type ConnectorCatalogOption = {
  id: string
  type: string
  name: string
  description?: string | null
}

type Binding = {
  connector: { id: string; name: string; type: string }
  accessMode: 'read' | 'write'
}

export function AgentConnectorBindingForm({
  agentId,
  bindings,
  catalog = [],
  suggestedConnectorNames,
  bare = false,
  onAssigned,
}: {
  agentId: string
  bindings: Binding[]
  catalog?: ConnectorCatalogOption[]
  suggestedConnectorNames?: string[]
  bare?: boolean
  onAssigned?: () => void
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const suggested = useMemo(
    () => matchAssignableConnectorsByName(catalog, suggestedConnectorNames ?? []),
    [catalog, suggestedConnectorNames],
  )
  const ordered = useMemo(() => {
    if (suggested.length === 0) return catalog
    const suggestedIds = new Set(suggested.map((item) => item.id))
    return [...suggested, ...catalog.filter((item) => !suggestedIds.has(item.id))]
  }, [catalog, suggested])
  const [connectorId, setConnectorId] = useState(suggested[0]?.id ?? catalog[0]?.id ?? '')
  const [accessMode, setAccessMode] = useState<'read' | 'write'>('read')
  const selected = ordered.find((item) => item.id === connectorId)

  function refresh() {
    onAssigned?.()
    router.refresh()
  }

  const body = (
    <>
      {bindings.length === 0 ? (
        <p className="text-sm text-ink-soft">Nincs kötött konnektor.</p>
      ) : (
        <ul className="space-y-2">
          {bindings.map((row) => (
            <li
              key={row.connector.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 px-3 py-2 text-sm"
            >
              <span>
                {row.connector.name}{' '}
                <span className="text-xs text-ink-faint">
                  ({row.connector.type} · {row.accessMode})
                </span>
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  start(async () => {
                    setError(null)
                    setDone(null)
                    const result = await unassignConnectorFromAgent({
                      agentId,
                      connectorId: row.connector.id,
                    })
                    if (!result.success) {
                      setError(result.error)
                      return
                    }
                    setDone(`„${row.connector.name}” leválasztva.`)
                    refresh()
                  })
                }}
                className="text-xs font-medium text-coral disabled:opacity-50"
              >
                Leválasztás
              </button>
            </li>
          ))}
        </ul>
      )}

      {suggested.length > 0 ? (
        <p className="mt-4 rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-ink">
          Javasolt kapcsolatok felülre kerültek — csak akkor kötődnek, ha hozzárendeled.
        </p>
      ) : null}

      {ordered.length === 0 ? (
        <p className="mt-4 text-sm text-ink-soft">
          Nincs több hozzárendelhető aktív kapcsolat.{' '}
          <OpenInNewWindowLink href={CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connections}>
            Új konnektor
          </OpenInNewWindowLink>
        </p>
      ) : (
        <form
          className="mt-4 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            start(async () => {
              setError(null)
              setDone(null)
              const result = await assignConnectorToAgent({
                agentId,
                connectorId,
                accessMode,
              })
              if (!result.success) {
                setError(result.error)
                return
              }
              setDone(selected ? `„${selected.name}” hozzárendelve.` : 'Kapcsolat hozzárendelve.')
              refresh()
            })
          }}
        >
          <label className="min-w-[12rem] flex-1 text-sm">
            Kapcsolat
            <select
              className="mt-1 block w-full rounded-lg border border-line bg-paper px-3 py-2"
              value={connectorId}
              onChange={(e) => setConnectorId(e.target.value)}
              required
            >
              {ordered.map((item) => (
                <option key={item.id} value={item.id}>
                  {suggested.some((row) => row.id === item.id) ? 'Javasolt · ' : ''}
                  {item.name} ({item.type})
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Mód
            <select
              className="mt-1 block rounded-lg border border-line bg-paper px-3 py-2"
              value={accessMode}
              onChange={(e) => setAccessMode(e.target.value as 'read' | 'write')}
            >
              <option value="read">olvasás</option>
              <option value="write">írás</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={pending || !connectorId}
            className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {pending ? 'Mentés…' : 'Kötés'}
          </button>
        </form>
      )}
      {selected?.description ? (
        <p className="mt-2 text-xs text-ink-soft">{selected.description}</p>
      ) : null}
      {done ? (
        <p className="mt-2 rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
          {done}
        </p>
      ) : null}
      {error ? <p className="mt-2 text-sm text-coral-deep">{error}</p> : null}
    </>
  )

  if (bare) return body
  return <Card title="Konnektorok">{body}</Card>
}

'use client'

import { useEffect, useState } from 'react'
import { listConnectorCatalog } from '@/app/actions/provisioning'
import { Card } from '@/components/ui/shell'

export function ProvisioningPanel(_props: {
  canManageCatalog: boolean
  isSuperadmin: boolean
  activeTenantId: string | null
}) {
  const [rows, setRows] = useState<Array<{ id: string; name: string; type: string; lifecycleState: string }>>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void listConnectorCatalog().then((result) => {
      if (!result.success) {
        setError(result.error)
        return
      }
      setRows(
        result.data.map((connector) => ({
          id: connector.id,
          name: connector.name,
          type: String(connector.type),
          lifecycleState: 'active',
        })),
      )
    })
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Konnektorok</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Katalógus</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Canonical connector CRUD. Az LLM provisioning-asszisztens kikerült.
        </p>
      </div>
      <Card title="Aktív kapcsolatok">
        {error ? <p className="text-sm text-coral-deep">{error}</p> : null}
        <ul className="divide-y divide-line/70">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between py-2 text-sm">
              <span className="font-medium">{row.name}</span>
              <span className="text-ink-soft">
                {row.type} · {row.lifecycleState}
              </span>
            </li>
          ))}
        </ul>
        {rows.length === 0 && !error ? (
          <p className="text-sm text-ink-soft">Nincs megjeleníthető konnektor.</p>
        ) : null}
      </Card>
    </div>
  )
}

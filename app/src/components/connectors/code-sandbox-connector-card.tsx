'use client'

import { useState, useTransition } from 'react'
import { Badge } from '@/components/ui/shell'
import { testCodeSandboxConnector } from '@/app/actions/code-sandbox'
import {
  CodeSandboxConnectorForm,
  CODE_SANDBOX_HELP,
  defaultCodeSandboxFormState,
  rowToForm,
  type CodeSandboxFormState,
} from '@/components/connectors/code-sandbox-connector-form'

type CodeSandboxConnectorRow = {
  id: string
  name: string
  lifecycleState: string
  hasApiKey: boolean
  config: {
    provider: 'cloud_run' | 'e2b_compatible'
    region: string
    baseUrl?: string
    maxExecSec: number
    cpuProfile: string
    memoryProfile: string
    maxCallsPerScope: number
    maxExecSecPerScope: number
  }
  recentCalls: Array<{
    status: string
    latencyMs: number
    metrics: Record<string, unknown> | null
    createdAt: string
  }>
}

export function CodeSandboxConnectorCard({
  row,
  onSaved,
}: {
  row: CodeSandboxConnectorRow
  onSaved?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [form, setForm] = useState<CodeSandboxFormState>(() => rowToForm(row))

  function test() {
    startTransition(async () => {
      setMessage(null)
      const result = await testCodeSandboxConnector({ connectorId: row.id })
      setMessage(
        result.success
          ? 'A provision → Python → fájlhíd → destroy próba sikeres.'
          : result.error,
      )
    })
  }

  return (
    <div className="rounded-lg border border-ink/12 bg-paper p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-ink">{row.name}</h3>
            <Badge tone={row.lifecycleState === 'active' ? 'success' : 'neutral'}>
              {row.lifecycleState === 'active' ? 'Aktív' : 'Leállítva'}
            </Badge>
            <Badge tone="neutral">Kódfuttató sandbox</Badge>
          </div>
          <p className="mt-1 text-xs text-ink-soft">{CODE_SANDBOX_HELP}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {row.config.provider} · {row.config.region}
            {row.config.baseUrl ? ` · ${row.config.baseUrl}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setForm(rowToForm(row))
              setEditing((open) => !open)
            }}
            className="rounded-md border border-ink/15 px-3 py-1.5 text-xs font-semibold text-ink-soft hover:text-ink"
          >
            {editing ? 'Bezárás' : 'Szerkesztés'}
          </button>
          <button
            type="button"
            onClick={test}
            disabled={pending}
            className="rounded-md border border-ink/15 px-3 py-1.5 text-xs font-semibold text-ink-soft hover:text-ink disabled:opacity-50"
          >
            Kapcsolat tesztelése
          </button>
        </div>
      </div>
      {row.recentCalls.length > 0 ? (
        <div className="mt-3 space-y-1 text-xs text-ink-faint">
          {row.recentCalls.map((call) => (
            <p key={call.createdAt}>
              {call.status} · {call.latencyMs} ms ·{' '}
              {new Date(call.createdAt).toLocaleString('hu-HU')}
            </p>
          ))}
        </div>
      ) : null}
      {message ? <p className="mt-2 text-sm text-ink-soft">{message}</p> : null}
      {editing ? (
        <div className="mt-4 border-t border-ink/10 pt-4">
          <CodeSandboxConnectorForm
            value={form}
            onChange={setForm}
            showConnectorPicker={false}
            onSaved={() => {
              setEditing(false)
              onSaved?.()
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

export function newCodeSandboxFormState(name = ''): CodeSandboxFormState {
  const base = defaultCodeSandboxFormState()
  return name.trim() ? { ...base, name: name.trim() } : base
}

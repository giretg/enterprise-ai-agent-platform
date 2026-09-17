'use client'

import { useState, useTransition } from 'react'
import { Badge } from '@/components/ui/shell'
import { testCodeSandboxConnector } from '@/app/actions/code-sandbox'
import { decommissionActiveConnector } from '@/app/actions/provisioning'
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
  const [confirmDecomm, setConfirmDecomm] = useState(false)
  const [decommReason, setDecommReason] = useState('')
  const [decommCriticality, setDecommCriticality] = useState<'L1' | 'L2' | 'L3'>('L1')
  const [decommApprover, setDecommApprover] = useState('')
  const isActive = row.lifecycleState === 'active'

  function toggleEditing() {
    setForm(rowToForm(row))
    setEditing((open) => !open)
  }

  function openForDecommission() {
    setForm(rowToForm(row))
    setEditing(true)
  }

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

  function decommission() {
    startTransition(async () => {
      const res = await decommissionActiveConnector({
        connectorId: row.id,
        criticality: decommCriticality,
        approverId: decommApprover.trim() || undefined,
        reason: decommReason.trim() || undefined,
      })
      if (!res.success) {
        setMessage(res.error)
        return
      }
      setConfirmDecomm(false)
      onSaved?.()
    })
  }

  return (
    <div className="rounded-lg border border-ink/12 bg-paper">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button
          type="button"
          className="font-semibold hover:underline"
          onClick={toggleEditing}
          aria-expanded={editing}
        >
          {editing ? '▾' : '▸'} {row.name}
        </button>
        <Badge tone={isActive ? 'success' : 'neutral'}>
          {isActive ? 'Aktív' : 'Leállítva'}
        </Badge>
        <Badge tone="neutral">Kódfuttató sandbox</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={toggleEditing}
            aria-expanded={editing}
            className="rounded-md border border-ink/20 px-2.5 py-1 text-xs font-semibold"
          >
            {editing ? 'Bezárás' : 'Szerkesztés'}
          </button>
          {editing ? (
            <button
              type="button"
              onClick={test}
              disabled={pending}
              className="rounded-md border border-ink/20 px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
            >
              Kapcsolat tesztelése
            </button>
          ) : null}
          {isActive ? (
            <button
              type="button"
              onClick={openForDecommission}
              className="rounded-md border border-coral/40 bg-coral/10 px-2.5 py-1 text-xs font-semibold text-coral"
            >
              Megszüntetés
            </button>
          ) : null}
        </div>
      </div>
      {editing ? (
        <div className="space-y-3 border-t border-ink/10 px-4 py-4 text-sm">
          <p className="text-xs text-ink-soft">{CODE_SANDBOX_HELP}</p>
          <p className="break-all text-xs text-ink-faint">
            {row.config.provider} · {row.config.region}
            {row.config.baseUrl ? ` · ${row.config.baseUrl}` : ''}
          </p>
          {row.recentCalls.length > 0 ? (
            <div className="space-y-1 text-xs text-ink-faint">
              {row.recentCalls.map((call) => (
                <p key={call.createdAt}>
                  {call.status} · {call.latencyMs} ms ·{' '}
                  {new Date(call.createdAt).toLocaleString('hu-HU')}
                </p>
              ))}
            </div>
          ) : null}
          {message ? <p className="text-sm text-ink-soft">{message}</p> : null}
          <CodeSandboxConnectorForm
            value={form}
            onChange={setForm}
            showConnectorPicker={false}
            onSaved={() => {
              setEditing(false)
              onSaved?.()
            }}
          />
          {isActive ? (
            <div className="rounded-md border border-coral/30 bg-coral/5 p-3">
              <h4 className="mb-2 font-semibold text-coral">Megszüntetés (auditált leszerelés)</h4>
              <p className="text-xs text-ink-soft">
                Nem hard-delete: a kapcsolat <code>archived</code> állapotba kerül — a sor és az
                audit-előzmény megmarad. Bank-preset / L2–L3 esetén második jóváhagyó kell.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="text-xs sm:col-span-2">
                  <span className="mb-1 block text-ink-soft">Indok (auditba kerül)</span>
                  <input
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={decommReason}
                    onChange={(e) => setDecommReason(e.target.value)}
                    placeholder="Pl. lecserélt sandbox, felesleges kapcsolat"
                  />
                </label>
                <label className="text-xs">
                  <span className="mb-1 block text-ink-soft">Kritikusság</span>
                  <select
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={decommCriticality}
                    onChange={(e) => setDecommCriticality(e.target.value as typeof decommCriticality)}
                  >
                    <option value="L1">L1</option>
                    <option value="L2">L2 (dual-control)</option>
                    <option value="L3">L3 (dual-control)</option>
                  </select>
                </label>
                <label className="text-xs">
                  <span className="mb-1 block text-ink-soft">2. jóváhagyó (≠ te)</span>
                  <input
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={decommApprover}
                    onChange={(e) => setDecommApprover(e.target.value)}
                    placeholder="user-id (dual-control esetén)"
                  />
                </label>
              </div>
              {!confirmDecomm ? (
                <button
                  type="button"
                  className="mt-3 rounded-md border border-coral/40 bg-coral/10 px-3 py-1.5 text-xs font-semibold text-coral"
                  onClick={() => setConfirmDecomm(true)}
                >
                  Megszüntetés
                </button>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-coral">
                    Biztos? A kapcsolat leszerelődik és archiválódik.
                  </span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={decommission}
                    className="rounded-md bg-coral px-3 py-1.5 text-xs font-semibold text-card disabled:opacity-50"
                  >
                    Igen, szüntesd meg
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDecomm(false)}
                    className="rounded-md border border-ink/20 px-3 py-1.5 text-xs font-semibold"
                  >
                    Mégse
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function newCodeSandboxFormState(name = ''): CodeSandboxFormState {
  const base = defaultCodeSandboxFormState()
  return name.trim() ? { ...base, name: name.trim() } : base
}

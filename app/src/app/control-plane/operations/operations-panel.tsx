'use client'

import { useState } from 'react'
import {
  approveGatewayOperationAction,
  rejectGatewayOperationAction,
} from '@/app/actions/gateway-operation'
import { formatToolUiName } from '@/lib/tool-ui-labels'
import { operationErrorLabel } from './labels'
import type { PendingOperationRow } from './types'

function agentDefinitionLabel(row: PendingOperationRow): string {
  if (row.definitionLabel && row.definitionLabel !== row.agentName) {
    return `${row.agentName} · ${row.definitionLabel}`
  }
  return row.agentName
}

function argsSummary(args: Record<string, unknown>): string {
  const name = typeof args.name === 'string' ? args.name : '—'
  const parent = typeof args.parentFolderId === 'string' && args.parentFolderId
    ? `szülő: ${args.parentFolderId}`
    : 'gyökér'
  return `${name} (${parent})`
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('hu-HU')
}

export function OperationsPanel({ operations }: { operations: PendingOperationRow[] }) {
  const [message, setMessage] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [reason, setReason] = useState<Record<string, string>>({})

  async function onApprove(operationId: string) {
    setBusyId(operationId)
    setMessage(null)
    const result = await approveGatewayOperationAction({ operationId })
    setBusyId(null)
    if (!result.success) {
      setMessage(operationErrorLabel(result.error))
      return
    }
    const fileId =
      result.data.result && typeof result.data.result === 'object'
        ? (result.data.result as { file?: { id?: string } }).file?.id
        : undefined
    setMessage(
      fileId
        ? `Jóváhagyva. Mappa azonosító: ${fileId}`
        : `Jóváhagyva. Állapot: ${result.data.status}`,
    )
  }

  async function onReject(operationId: string) {
    setBusyId(operationId)
    setMessage(null)
    const result = await rejectGatewayOperationAction({
      operationId,
      reason: reason[operationId]?.trim() || undefined,
    })
    setBusyId(null)
    if (!result.success) {
      setMessage(operationErrorLabel(result.error))
      return
    }
    setMessage('Elutasítva. A Google Drive-on nem jött létre mappa.')
  }

  if (operations.length === 0) {
    return <p className="text-sm text-ink-soft">Nincs jóváhagyásra váró művelet.</p>
  }

  return (
    <div className="space-y-4">
      {message ? (
        <p className="rounded-lg border border-ink/10 bg-white/40 px-3 py-2 text-sm text-ink">{message}</p>
      ) : null}
      <ul className="space-y-3">
        {operations.map((row) => {
          const busy = busyId === row.operationId
          return (
            <li
              key={row.operationId}
              className="rounded-xl border border-ink/10 bg-white/50 p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium text-ink">{formatToolUiName(row.toolName)}</p>
                <p className="text-xs text-ink-faint">{formatWhen(row.createdAt)}</p>
              </div>
              <p className="mt-1 text-sm text-ink-soft">
                {agentDefinitionLabel(row)} · {row.requesterName}
              </p>
              <p className="mt-1 text-sm text-ink">{argsSummary(row.args)}</p>
              <label className="mt-3 block text-xs text-ink-soft">
                Elutasítás indoka (opcionális)
                <textarea
                  className="mt-1 w-full rounded-md border border-ink/15 bg-white px-2 py-1 text-sm text-ink"
                  rows={2}
                  value={reason[row.operationId] ?? ''}
                  onChange={(event) =>
                    setReason((current) => ({ ...current, [row.operationId]: event.target.value }))
                  }
                />
              </label>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onApprove(row.operationId)}
                  className="rounded-md bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50"
                >
                  Jóváhagyás
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onReject(row.operationId)}
                  className="rounded-md border border-ink/20 px-3 py-1.5 text-sm text-ink disabled:opacity-50"
                >
                  Elutasítás
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

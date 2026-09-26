'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  approveGatewayOperationAction,
  rejectGatewayOperationAction,
} from '@/app/actions/gateway-operation'
import { pendingArgsSummary } from '@/domain/gateway-operation/pending-args-summary'
import { asTranslate, type TranslateFn } from '@/i18n/translate'
import { formatToolUiName } from '@/lib/tool-ui-labels'
import { operationErrorLabel } from './labels'
import type { PendingOperationRow } from './types'

function agentDefinitionLabel(row: PendingOperationRow): string {
  if (row.definitionLabel && row.definitionLabel !== row.agentName) {
    return `${row.agentName} · ${row.definitionLabel}`
  }
  return row.agentName
}

function argsSummary(toolName: string, args: Record<string, unknown>, t: TranslateFn): string {
  return pendingArgsSummary(toolName, args, {
    memoryKind: t('memoryKind'),
    parentRoot: t('parentRoot'),
    parentFolder: (id) => t('parentFolder', { id }),
  })
}

function formatWhen(iso: string, locale: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(locale === 'en' ? 'en-GB' : 'hu-HU')
}

export function OperationsPanel({ operations }: { operations: PendingOperationRow[] }) {
  const t = asTranslate(useTranslations('ControlPlane.operations'))
  const locale = useLocale()
  const [message, setMessage] = useState<string | null>(null)
  const [messageKind, setMessageKind] = useState<'info' | 'error'>('info')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [reason, setReason] = useState<Record<string, string>>({})

  async function onApprove(operationId: string) {
    setBusyId(operationId)
    setMessage(null)
    const result = await approveGatewayOperationAction({ operationId })
    setBusyId(null)
    if (!result.success) {
      setMessageKind('error')
      setMessage(operationErrorLabel(result.error, t))
      return
    }
    // Approve executes the write synchronously — the operation can come back
    // 'failed' (e.g. the target API rejected the payload) even though the
    // approve call itself succeeded. Surface that here instead of only in
    // the operation's own status text, or a failed write looks identical to
    // a successful one.
    if (result.data.status === 'failed') {
      setMessageKind('error')
      setMessage(
        t('approvedFailed', {
          error: operationErrorLabel(result.data.errorCode ?? 'tool_execution_failed', t),
        }),
      )
      return
    }
    const fileId =
      result.data.result && typeof result.data.result === 'object'
        ? (result.data.result as { file?: { id?: string } }).file?.id
        : undefined
    setMessageKind('info')
    setMessage(
      fileId
        ? t('approvedFile', { fileId })
        : t('approvedStatus', { status: result.data.status }),
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
      setMessageKind('error')
      setMessage(operationErrorLabel(result.error, t))
      return
    }
    setMessageKind('info')
    setMessage(t('rejected'))
  }

  if (operations.length === 0) {
    return <p className="text-sm text-ink-soft">{t('empty')}</p>
  }

  return (
    <div className="space-y-4">
      {message ? (
        <p
          className={
            messageKind === 'error'
              ? 'rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800'
              : 'rounded-lg border border-ink/10 bg-white/40 px-3 py-2 text-sm text-ink'
          }
        >
          {message}
        </p>
      ) : null}
      <ul className="space-y-3">
        {operations.map((row) => {
          const busy = busyId === row.operationId
          return (
            <li
              key={row.operationId}
              id={row.operationId}
              className="rounded-xl border border-ink/10 bg-white/50 p-4 shadow-sm target:ring-2 target:ring-coral"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium text-ink">{formatToolUiName(row.toolName)}</p>
                <p className="text-xs text-ink-faint">{formatWhen(row.createdAt, locale)}</p>
              </div>
              <p className="mt-1 text-sm text-ink-soft">
                {agentDefinitionLabel(row)} · {row.requesterName}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">
                {argsSummary(row.toolName, row.args, t)}
              </p>
              <label className="mt-3 block text-xs text-ink-soft">
                {t('rejectReason')}
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
                  {t('approve')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onReject(row.operationId)}
                  className="rounded-md border border-ink/20 px-3 py-1.5 text-sm text-ink disabled:opacity-50"
                >
                  {t('reject')}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

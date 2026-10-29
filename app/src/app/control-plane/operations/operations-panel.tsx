'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  approveGatewayOperationAction,
  rejectGatewayOperationAction,
} from '@/app/actions/gateway-operation'
import { asTranslate } from '@/i18n/translate'
import { operationErrorLabel } from './labels'
import { WikiChangeSetReview } from '@/components/knowledge/wiki/wiki-change-set-review'
import type { PendingOperationRow } from './types'
import {
  OperationConnectorIcon,
  OperationSummaryBlock,
  OperationTitleLine,
} from './operation-row-parts'

export function OperationsPanel({ operations }: { operations: PendingOperationRow[] }) {
  const t = asTranslate(useTranslations('ControlPlane.operations'))
  const [message, setMessage] = useState<string | null>(null)
  const [messageKind, setMessageKind] = useState<'info' | 'error'>('info')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [reason, setReason] = useState<Record<string, string>>({})
  const [rejectingId, setRejectingId] = useState<string | null>(null)

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
    setRejectingId(null)
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
          const rejecting = rejectingId === row.operationId
          return (
            <li
              key={row.operationId}
              id={row.operationId}
              className="rounded-xl border border-ink/10 bg-white/50 p-3 shadow-sm target:ring-2 target:ring-coral"
            >
              <div className="flex items-start gap-3">
                <OperationConnectorIcon row={row} />
                <div className="min-w-0 flex-1">
                  <OperationTitleLine row={row} />
                  {row.designatedApproverName ? (
                    <p className="mt-1 text-sm font-medium text-coral-deep">
                      {row.designatedApproverName} jóváhagyására vár
                      {row.designatedApproverUserId === row.principalUserId
                        ? ' — a kérelmező saját magának is jóváhagyhatja'
                        : ''}
                    </p>
                  ) : null}
                  {row.toolName === 'kb_wiki_write' && typeof row.args.changeSetId === 'string' ? (
                    <WikiChangeSetReview
                      changeSetId={row.args.changeSetId}
                      busy={busy}
                      onApprove={() => {
                        setRejectingId(null)
                        void onApprove(row.operationId)
                      }}
                      onReject={() => setRejectingId(row.operationId)}
                    />
                  ) : (
                    <OperationSummaryBlock row={row} t={t} expanded mode="details" />
                  )}
                  {rejecting ? (
                    <label className="mt-2 block text-xs text-ink-soft">
                      {t('rejectReason')}
                      <textarea
                        autoFocus
                        className="mt-1 w-full rounded-md border border-ink/15 bg-white px-2 py-1 text-sm text-ink"
                        rows={2}
                        value={reason[row.operationId] ?? ''}
                        onChange={(event) =>
                          setReason((current) => ({ ...current, [row.operationId]: event.target.value }))
                        }
                      />
                    </label>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setRejectingId(null)
                        void onApprove(row.operationId)
                      }}
                      className="rounded-md bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50"
                    >
                      {t('approve')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!rejecting) {
                          setRejectingId(row.operationId)
                          return
                        }
                        void onReject(row.operationId)
                      }}
                      className="rounded-md border border-ink/20 px-3 py-1.5 text-sm text-ink disabled:opacity-50"
                    >
                      {t('reject')}
                    </button>
                  </div>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

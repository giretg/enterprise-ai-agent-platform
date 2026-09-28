'use client'

import { useEffect, useState, useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { listGatewayOperationHistoryAction } from '@/app/actions/gateway-operation'
import { asTranslate } from '@/i18n/translate'
import type { PendingOperationRow } from './types'
import {
  OperationConnectorIcon,
  OperationSummaryBlock,
  OperationTitleLine,
  agentDefinitionLabel,
  formatWhen,
} from './operation-row-parts'

function decisionLabel(status: string, decision: string | undefined, t: (key: string) => string): string {
  if (decision === 'rejected' || status === 'rejected') return t('historyRejected')
  if (status === 'failed') return t('historyFailed')
  if (status === 'succeeded') return t('historySucceeded')
  return t('historyApproved')
}

export function OperationsHistoryPanel() {
  const t = asTranslate(useTranslations('ControlPlane.operations'))
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<PendingOperationRow[]>([])
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    if (!open) return
    start(async () => {
      const result = await listGatewayOperationHistoryAction({ page })
      if (!result.success) return
      setRows(result.data.rows)
      setTotal(result.data.total)
      setPageSize(result.data.pageSize)
    })
  }, [open, page])

  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  return (
    <section className="space-y-3 border-t border-line/60 pt-8">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          <h2 className="font-display text-lg font-semibold text-ink">{t('historyTitle')}</h2>
          <p className="mt-0.5 text-sm text-ink-soft">{t('historyBody')}</p>
        </span>
        <span className="shrink-0 text-sm text-ink-faint">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="space-y-3">
          {pending && rows.length === 0 ? (
            <p className="text-sm text-ink-soft">{t('historyLoading')}</p>
          ) : null}
          {!pending && rows.length === 0 ? (
            <p className="text-sm text-ink-soft">{t('historyEmpty')}</p>
          ) : (
            <ul className="space-y-2">
              {rows.map((row) => {
                const expanded = expandedId === row.operationId
                const decision = row.approval?.decision
                return (
                  <li
                    key={row.operationId}
                    className="rounded-lg border border-ink/10 bg-white/40 px-3 py-2 text-sm"
                  >
                    <div className="flex items-start gap-3">
                      <OperationConnectorIcon row={row} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <OperationTitleLine row={row} />
                          <p className="text-xs text-ink-faint">{formatWhen(row.updatedAt, locale)}</p>
                        </div>
                        <p className="mt-1 text-xs text-ink-soft">
                          {agentDefinitionLabel(row)} · {row.requesterName}
                        </p>
                        <p className="mt-1 text-xs font-medium text-ink-faint">
                          {decisionLabel(row.status, decision ?? undefined, t)}
                        </p>
                        <OperationSummaryBlock row={row} t={t} expanded={expanded} mode="headline" />
                        <button
                          type="button"
                          className="mt-2 text-xs font-medium text-coral-deep"
                          onClick={() =>
                            setExpandedId((current) =>
                              current === row.operationId ? null : row.operationId,
                            )
                          }
                        >
                          {expanded ? t('hideDetails') : t('showDetails')}
                        </button>
                        <OperationSummaryBlock row={row} t={t} expanded={expanded} mode="details" />
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {total > pageSize ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
              <button
                type="button"
                disabled={pending || page <= 1}
                className="rounded-md border border-ink/15 px-2 py-1 disabled:opacity-40"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                {t('historyPrev')}
              </button>
              <span>
                {t('historyPage', { page, pages: pageCount })}
              </span>
              <button
                type="button"
                disabled={pending || page >= pageCount}
                className="rounded-md border border-ink/15 px-2 py-1 disabled:opacity-40"
                onClick={() => setPage((p) => p + 1)}
              >
                {t('historyNext')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

'use client'

import { ConnectorTemplateIcon } from '@/components/account/provider-icon'
import { formatToolUiName } from '@/lib/tool-ui-labels'
import {
  pendingArgsSummary,
  pendingOperationHeadline,
} from '@/domain/gateway-operation/pending-args-summary'
import type { TranslateFn } from '@/i18n/translate'
import type { PendingOperationRow } from './types'

export function formatWhen(iso: string, locale: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(locale === 'en' ? 'en-GB' : 'hu-HU')
}

export function agentDefinitionLabel(row: PendingOperationRow): string {
  if (row.definitionLabel && row.definitionLabel !== row.agentName) {
    return `${row.agentName} · ${row.definitionLabel}`
  }
  return row.agentName
}

export function OperationConnectorIcon({ row }: { row: PendingOperationRow }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-ink/10 bg-white">
      <ConnectorTemplateIcon
        iconDataUrl={row.connectorIconDataUrl}
        provider={row.connectorIconProvider}
        className="h-5 w-5"
      />
    </span>
  )
}

export function OperationSummaryBlock({
  row,
  t,
  expanded,
  mode,
}: {
  row: PendingOperationRow
  t: TranslateFn
  expanded: boolean
  mode: 'headline' | 'details'
}) {
  const headline = pendingOperationHeadline(row.toolName, row.args, {
    connectorName: row.connectorName ?? undefined,
  })
  if (mode === 'headline') {
    return <p className="mt-1 text-sm text-ink">{headline}</p>
  }
  if (!expanded) return null
  const details = pendingArgsSummary(row.toolName, row.args, {
    memoryKind: t('memoryKind'),
    parentRoot: t('parentRoot'),
    parentFolder: (id) => t('parentFolder', { id }),
  })
  return (
    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-ink/10 bg-paper/80 p-2 font-mono text-xs text-ink-soft">
      {details}
    </pre>
  )
}

export function OperationTitleLine({ row }: { row: PendingOperationRow }) {
  const connector = row.connectorName
  return (
    <div className="min-w-0">
      <p className="font-medium text-ink">
        {connector ? connector : formatToolUiName(row.toolName)}
      </p>
      <p className="text-xs text-ink-faint">
        {connector ? formatToolUiName(row.toolName) : row.toolName}
      </p>
    </div>
  )
}

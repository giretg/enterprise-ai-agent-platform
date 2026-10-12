'use client'

import { ConnectorTemplateIcon } from '@/components/account/provider-icon'
import { getToolUiLabel } from '@/lib/tool-ui-labels'
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
    endpointDescription: row.endpointDescription,
  })
  if (mode === 'headline') {
    return <p className="mt-1 text-sm text-ink">{headline}</p>
  }
  if (!expanded) return null
  const details = pendingArgsSummary(row.toolName, row.args, {
    memoryKind: t('memoryKind'),
    parentRoot: t('parentRoot'),
    parentFolder: (id) => t('parentFolder', { id }),
    endpointDescription: row.endpointDescription,
  })
  return (
    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm text-ink">
      {details}
    </pre>
  )
}

export function OperationTitleLine({ row }: { row: PendingOperationRow }) {
  return (
    <p className="font-medium text-ink">
      {row.connectorName || getToolUiLabel(row.toolName).label}
    </p>
  )
}

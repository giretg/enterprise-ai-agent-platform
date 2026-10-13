'use client'

import { ConnectorTemplateIcon } from '@/components/account/provider-icon'
import { getToolUiLabel } from '@/lib/tool-ui-labels'
import {
  pendingArgsSummary,
  pendingOperationHeadline,
  splitLabelledSections,
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

const MEMORY_KIND_LABEL: Record<string, string> = {
  session_log: 'Munkamenet-napló',
  focus: 'Fókusz',
}

function MemoryWriteView({ args }: { args: Record<string, unknown> }) {
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')
  const kind = text('kind')
  const project = text('projectKey')
  const sections = splitLabelledSections(text('body'))
  // replaceId/mergeIds/artifactPath change what gets overwritten — keep them visible.
  const meta = [
    ['felülírja', text('replaceId')],
    ['összevonja', text('mergeIds')],
    ['melléklet', text('artifactPath')],
  ].filter(([, value]) => value)
  return (
    <div className="mt-1 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-ink/5 px-2 py-0.5 text-xs font-medium text-ink-soft">
          {MEMORY_KIND_LABEL[kind] ?? (kind || 'emlék')}
        </span>
        <span className="text-xs text-ink-faint">
          {project && project !== '__general__' ? project : 'általános'}
        </span>
      </div>
      {text('title') ? <p className="text-sm font-medium text-ink">{text('title')}</p> : null}
      <dl className="max-h-80 space-y-2 overflow-auto rounded-lg border border-ink/10 bg-paper/60 p-3">
        {sections.map((section, index) => (
          <div
            key={index}
            className={section.label ? 'sm:grid sm:grid-cols-[7.5rem_1fr] sm:gap-3' : undefined}
          >
            {section.label ? (
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                {section.label}
              </dt>
            ) : null}
            <dd className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
              {section.text}
            </dd>
          </div>
        ))}
      </dl>
      {meta.map(([label, value]) => (
        <p key={label} className="break-all text-xs text-ink-faint">
          {label}: <code className="font-mono">{value}</code>
        </p>
      ))}
    </div>
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
  if (row.toolName === 'platform.project_memory.write') return <MemoryWriteView args={row.args} />
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

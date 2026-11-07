'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { KnowledgeCatalogFileControls, KnowledgeCatalogUploadForm } from '@/components/knowledge/knowledge-catalog-manager'
import { Card } from '@/components/ui/shell'
import { formatBytes, formatWhen, wikiHref } from './wiki-format'

export type WikiFileRow = {
  id: string
  filename: string
  purpose: string | null
  bytes: number
  createdAt: string
  kbLanguageOverride: string | null
  wikiState: 'none' | 'paged' | 'pending' | 'in_progress' | 'processed' | 'skipped'
}

/** #1139: a tudásbázis összes fájlja egy helyen, függetlenül attól, hogy épül-e belőlük wiki. */
export function WikiFilesPanel({
  connectorId,
  kind,
  ownerAgentId,
  canManage,
  files,
  truncated,
}: {
  connectorId: string
  kind: 'catalog' | 'agent' | 'shared' | 'private' | 'members' | 'public'
  ownerAgentId: string | null
  canManage: boolean
  files: WikiFileRow[]
  truncated: boolean
}) {
  const t = useTranslations('ControlPlane.wiki.files')
  const locale = useLocale()
  const managesCatalog = kind === 'catalog' && canManage

  return (
    <Card title={t('title')}>
      <p className="mb-4 max-w-2xl text-sm text-ink-soft">{t('intro')}</p>
      {managesCatalog ? <KnowledgeCatalogUploadForm /> : <ManageHint connectorId={connectorId} kind={kind} ownerAgentId={ownerAgentId} />}
      {files.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-3 text-sm text-ink-soft" data-testid="wiki-files-empty">
          {t('empty')}
        </p>
      ) : (
        <ul className="space-y-2" data-testid="wiki-files">
          {files.map((file) => (
            <li
              key={file.id}
              data-testid="wiki-file-row"
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-line/70 px-3 py-2 text-sm"
            >
              <span className="min-w-0">
                <Link href={wikiHref(connectorId, { tab: 'files', source: file.id })} className="break-words font-medium text-ink hover:text-coral-deep">
                  {file.filename}
                </Link>
                {file.purpose ? <span className="block text-xs text-ink-soft">{file.purpose}</span> : null}
                <span className="block text-xs text-ink-faint">
                  {formatWhen(file.createdAt, locale)} · {formatBytes(file.bytes, locale)} · {t(`wikiState.${file.wikiState}`)}
                </span>
              </span>
              {managesCatalog ? (
                <KnowledgeCatalogFileControls documentId={file.id} filename={file.filename} kbLanguageOverride={file.kbLanguageOverride} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {truncated ? <p className="mt-3 text-xs text-ink-faint">{t('truncated', { count: files.length })}</p> : null}
    </Card>
  )
}

/** Megmondja, hol tölthető fel és törölhető fájl ennél a tudásbázisnál. */
function ManageHint({
  connectorId,
  kind,
  ownerAgentId,
}: {
  connectorId: string
  kind: 'catalog' | 'agent' | 'shared' | 'private' | 'members' | 'public'
  ownerAgentId: string | null
}) {
  const t = useTranslations('ControlPlane.wiki.files.manage')
  const className = 'mb-4 max-w-2xl text-xs text-ink-faint'
  if (kind === 'catalog') return <p className={className}>{t('catalogAdminOnly')}</p>
  const target =
    kind === 'agent' && ownerAgentId
      ? { href: `/control-plane/agents/${ownerAgentId}?section=tudasbazis`, text: t('agent'), link: t('agentLink') }
      : kind === 'public' && ownerAgentId
        ? { href: `/control-plane/agents/${ownerAgentId}?tab=tudas`, text: t('public'), link: t('publicLink') }
        : { href: wikiHref(connectorId, { tab: 'inbox' }), text: t('inbox'), link: t('inboxLink') }
  return (
    <p className={className}>
      {target.text}{' '}
      <Link href={target.href} data-testid="wiki-files-manage-link" className="font-medium text-coral hover:text-coral-deep">
        {target.link}
      </Link>
    </p>
  )
}

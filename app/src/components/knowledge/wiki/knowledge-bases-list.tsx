'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { createKnowledgeBaseAction } from '@/app/actions/knowledge-wiki'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Badge, Card } from '@/components/ui/shell'
import { formatBytes, wikiHref } from './wiki-format'

export type KnowledgeBaseListRow =
  | {
      connectorId: string
      kind: 'catalog' | 'agent' | 'shared' | 'private'
      metadataOnly: true
      ownerLabel: string | null
      sourceCount: number
      pageCount: number
      bytes: number
    }
  | {
      connectorId: string
      kind: 'catalog' | 'agent' | 'shared' | 'private'
      metadataOnly: false
      name: string
      ownerLabel: string | null
      canManage: boolean
      inbox: { pending: number; inProgress: number }
      sourceCount: number
      pageCount: number
      bytes: number
    }

export function KnowledgeBasesList({
  rows,
  canCreateShared,
}: {
  rows: KnowledgeBaseListRow[]
  canCreateShared: boolean
}) {
  const t = useTranslations('ControlPlane.wiki')
  const locale = useLocale()
  const router = useRouter()
  const [pending, start] = useTransition()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [isPrivate, setIsPrivate] = useState(!canCreateShared)
  const [template, setTemplate] = useState<'general' | 'health-journal'>('general')
  const [error, setError] = useState<string | null>(null)

  const stats = (row: KnowledgeBaseListRow) =>
    t('list.stats', {
      sources: row.sourceCount,
      pages: row.pageCount,
      size: formatBytes(row.bytes, locale),
    })

  return (
    <Card title={t('list.title')}>
      <p className="mb-4 max-w-2xl text-sm text-ink-soft">{t('list.intro')}</p>

      {rows.length === 0 ? (
        <p className="mb-4 rounded-lg border border-dashed border-line px-3 py-3 text-sm text-ink-soft">{t('list.empty')}</p>
      ) : (
        <ul className="mb-4 space-y-2" data-testid="kb-list">
          {rows.map((row) =>
            row.metadataOnly ? (
              <li
                key={row.connectorId}
                data-testid="kb-row-private-meta"
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line/70 bg-paper/50 px-3 py-2 text-sm text-ink-soft"
              >
                <Badge tone="warning">{t('kind.private')}</Badge>
                <span>{row.ownerLabel ?? t('list.unknownOwner')}</span>
                <span className="text-ink-faint">· {stats(row)}</span>
                <HelpHint>{t('list.privateMetaHelp')}</HelpHint>
              </li>
            ) : (
              <li key={row.connectorId}>
                <Link
                  href={wikiHref(row.connectorId)}
                  data-testid="kb-row"
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-line/70 px-3 py-2 text-sm hover:border-coral/50"
                >
                  <span className="font-medium text-ink">{row.name}</span>
                  <Badge tone={row.kind === 'private' ? 'warning' : 'neutral'}>{t(`kind.${row.kind}`)}</Badge>
                  <span className="text-ink-faint">{stats(row)}</span>
                  {row.inbox.pending + row.inbox.inProgress > 0 ? (
                    <span className="ml-auto rounded-full bg-coral/10 px-2 py-0.5 text-xs font-medium text-coral-deep">
                      {t('list.inboxBadge', { count: row.inbox.pending + row.inbox.inProgress })}
                    </span>
                  ) : null}
                </Link>
              </li>
            ),
          )}
        </ul>
      )}

      {open ? (
        <form
          className="space-y-3 rounded-lg border border-line/70 p-3"
          onSubmit={(event) => {
            event.preventDefault()
            start(async () => {
              setError(null)
              const res = await createKnowledgeBaseAction({
                displayName: name,
                private: isPrivate,
                template,
                kbLanguage: locale === 'en' ? 'en' : 'hu',
              })
              if (!res.success) {
                setError(t(`errors.${errorKey(res.error)}`))
                return
              }
              router.push(wikiHref(res.data.connectorId))
            })
          }}
        >
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-ink-faint">{t('create.name')}</span>
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('create.namePlaceholder')}
              data-testid="kb-create-name"
              className="w-full rounded-lg border border-line/70 px-3 py-1.5 text-sm"
            />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPrivate}
              disabled={!canCreateShared}
              onChange={(event) => setIsPrivate(event.target.checked)}
              data-testid="kb-create-private"
            />
            <span>
              <span className="font-medium">{t('create.private')}</span>
              <span className="block text-xs text-ink-faint">
                {canCreateShared ? t('create.privateHelp') : t('create.privateOnly')}
              </span>
            </span>
          </label>
          {isPrivate ? (
            <p className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {t('create.privateNotice')}
            </p>
          ) : null}
          <fieldset className="space-y-1">
            <legend className="mb-1 flex items-center text-xs text-ink-faint">
              {t('create.template')}
              <HelpHint>{t('create.templateHelp')}</HelpHint>
            </legend>
            {(['general', 'health-journal'] as const).map((id) => (
              <label key={id} className="flex gap-2 text-sm">
                <input type="radio" name="template" checked={template === id} onChange={() => setTemplate(id)} />
                <span>
                  <span className="font-medium">{t(`templates.${id}.name`)}</span>
                  <span className="block text-xs text-ink-faint">{t(`templates.${id}.description`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {error ? <p className="text-sm text-coral-deep">{error}</p> : null}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending || !name.trim()}
              data-testid="kb-create-submit"
              className="rounded-lg bg-coral px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? t('create.creating') : t('create.submit')}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-line px-3 py-1.5 text-sm">
              {t('common.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="kb-create-open"
          className="rounded-lg bg-coral px-3 py-1.5 text-sm font-medium text-white"
        >
          {t('create.open')}
        </button>
      )}
    </Card>
  )
}

const KNOWN_ERRORS = ['not_found', 'forbidden', 'invalid_args', 'too_large'] as const

export function errorKey(code: string): (typeof KNOWN_ERRORS)[number] | 'generic' {
  return (KNOWN_ERRORS as readonly string[]).includes(code) ? (code as (typeof KNOWN_ERRORS)[number]) : 'generic'
}

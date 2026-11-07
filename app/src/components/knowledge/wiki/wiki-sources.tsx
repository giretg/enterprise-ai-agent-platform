'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import type { WikiSourceView } from '@/domain/knowledge-base/wiki-console-service'
import { wikiHref } from './wiki-format'

/**
 * #1061 F2: egy oldal forrásai — feltöltött dokumentum (ebből vagy egy másik tudástárból),
 * emberi rögzítés („Emberi rögzítés · név · dátum · alkalom”), vagy olyan másik tudástár
 * forrása, amelyhez a nézőnek nincs hozzáférése (tartalom és név nélkül).
 */
export function WikiSourceLabel({
  connectorId,
  source,
  linkQuery,
}: {
  connectorId: string
  source: WikiSourceView
  /** Olvasó nézetben a forrás is olvasó nézetben nyílik. */
  linkQuery?: Record<string, string>
}) {
  const t = useTranslations('ControlPlane.wiki.page')
  const locale = useLocale()
  if (source.kind === 'restricted') {
    return <span className="text-ink-faint" data-testid="wiki-source-restricted">{t('sourceRestricted')}</span>
  }
  if (source.kind === 'human_note') {
    const when = source.recordedAt ? new Date(source.recordedAt).toLocaleDateString(locale) : ''
    return (
      <span data-testid="wiki-source-human-note">
        <span className="font-medium">{t('humanNote')}</span>
        {' · '}
        {source.recordedBy ?? t('unknownRecorder')}
        {when ? ` · ${when}` : ''}
        {source.occasion ? ` · ${source.occasion}` : ''}
        {source.participants ? <span className="text-ink-faint"> ({t('participants', { names: source.participants })})</span> : null}
      </span>
    )
  }
  if (source.kind === 'wiki_comment') {
    // #1129 D6: a forrás a kommentre mutat; törölt kommentnél név és dátum nélkül.
    if (source.erased || !source.commentedAt) return <span className="text-ink-faint" data-testid="wiki-source-comment">{t('commentSourceErased')}</span>
    return (
      <span data-testid="wiki-source-comment">
        {t('commentSource', { name: source.authorName ?? '—', date: new Date(source.commentedAt).toLocaleDateString(locale) })}
      </span>
    )
  }
  const owner = source.connectorId ?? connectorId
  const label = `${source.filename ?? source.documentId}${source.page ? `, ${t('pageN', { n: source.page })}` : ''}${source.section ? ` · ${source.section}` : ''}`
  if (!source.exists) {
    return <span className="text-ink-faint">{label} ({t('sourceMissing')})</span>
  }
  return (
    <span>
      <Link
        href={`${wikiHref(owner, { ...linkQuery, source: source.documentId, p: source.page ? String(source.page) : undefined })}${source.page ? `#p-${source.page}` : ''}`}
        className="text-coral-deep hover:underline"
      >
        {label}
      </Link>
      {source.connectorId ? <span className="ml-1 text-xs text-ink-faint">({t('sourceOtherWiki')})</span> : null}
    </span>
  )
}

export function WikiSourceList({
  connectorId,
  sources,
  linkQuery,
}: {
  connectorId: string
  sources: WikiSourceView[]
  linkQuery?: Record<string, string>
}) {
  return (
    <ul className="space-y-1 text-sm" data-testid="wiki-page-sources">
      {sources.map((source, index) => (
        <li key={index}>
          <WikiSourceLabel connectorId={connectorId} source={source} linkQuery={linkQuery} />
        </li>
      ))}
    </ul>
  )
}

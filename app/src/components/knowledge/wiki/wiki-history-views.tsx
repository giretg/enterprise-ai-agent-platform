/**
 * #978 Wiki-előzmények nézetei (szerver-komponensek): oldal-idővonal, korábbi
 * verzió, két verzió összevetése, „Változások” fül, change-set nézet, időutazás-sáv.
 */
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import {
  diffWikiRevisionsAction,
  getWikiChangeSetAction,
  getWikiPageHistoryAction,
  getWikiRevisionAction,
  listWikiChangesAction,
} from '@/app/actions/knowledge-wiki'
import { Badge, Card } from '@/components/ui/shell'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { collapseUnchanged, type LineDiffRow } from '@/lib/text-line-diff'
import { WikiMarkdown } from './wiki-markdown'
import { WikiRevertButton, WikiTagDeleteButton, WikiTagForm } from './wiki-history-actions'
import { formatWhen, wikiHref } from './wiki-format'

type Author = { kind: 'agent' | 'human'; name: string | null } | null
type HistoryT = Awaited<ReturnType<typeof getTranslations<'ControlPlane.wiki.history'>>>

function authorLabel(author: Author, t: HistoryT) {
  if (!author) return t('unknownAuthor')
  return `${author.name ?? '—'}${author.kind === 'agent' ? ` (${t('agent')})` : ''}`
}

const FIELD_KEYS = ['title', 'summary', 'path', 'status', 'category', 'sources'] as const
type FieldKey = (typeof FIELD_KEYS)[number]

export function DiffRows({ rows, unchangedLabel }: { rows: LineDiffRow[]; unchangedLabel: (count: number) => string }) {
  const collapsed = collapseUnchanged(rows)
  return (
    <pre className="max-h-[32rem] overflow-auto rounded-lg border border-line/70 px-3 py-2 font-mono text-xs leading-relaxed" data-testid="wiki-diff">
      {collapsed.length === 0 ? <div className="text-ink-faint">{unchangedLabel(0)}</div> : null}
      {collapsed.map((row, index) =>
        row.kind === 'skip' ? (
          <div key={index} className="text-ink-faint">
            {unchangedLabel(row.count)}
          </div>
        ) : (
          <div
            key={index}
            className={
              row.kind === 'add'
                ? 'bg-sage/15 text-ink'
                : row.kind === 'del'
                  ? 'bg-coral/10 text-coral-deep line-through decoration-coral/40'
                  : 'text-ink-soft'
            }
          >
            {row.kind === 'add' ? '+ ' : row.kind === 'del' ? '− ' : '  '}
            {row.text || ' '}
          </div>
        ),
      )}
    </pre>
  )
}

function FieldChanges({ fields, t }: { fields: Array<{ field: string; before: string; after: string }>; t: HistoryT }) {
  if (fields.length === 0) return null
  return (
    <dl className="mb-2 space-y-1 text-xs" data-testid="wiki-field-changes">
      {fields.map((row) => (
        <div key={row.field} className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-ink">
            {(FIELD_KEYS as readonly string[]).includes(row.field) ? t(`fields.${row.field as FieldKey}`) : row.field}
          </dt>
          <dd className="text-ink-soft">
            <span className="text-coral-deep line-through decoration-coral/40">{row.before || '—'}</span>
            {' → '}
            <span className="text-ink">{row.after || '—'}</span>
          </dd>
        </div>
      ))}
    </dl>
  )
}

// ---------------------------------------------------------------------------
// Oldal-idővonal (§5.1)

export async function PageHistoryPanel({ connectorId, path, locale }: { connectorId: string; path: string; locale: string }) {
  const t = await getTranslations('ControlPlane.wiki.history')
  const res = await getWikiPageHistoryAction({ connectorId, path })
  if (!res.success || res.data.revisions.length === 0) return null
  const history = res.data
  const ordered = history.revisions
  return (
    <section className="mt-4 border-t border-line/70 pt-3" data-testid="wiki-page-history">
      <p className="mb-2 flex items-center text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
        {t('timeline.title', { count: ordered.length })}
        <HelpHint>{t('timeline.help')}</HelpHint>
      </p>
      <ol className="space-y-2">
        {ordered.map((rev, index) => {
          const previous = ordered[index + 1]
          return (
            <li key={rev.version} className="rounded-lg border border-line/60 px-3 py-2 text-sm" data-testid="wiki-revision-row">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-ink">v{rev.version}</span>
                <span className="text-xs text-ink-faint">{formatWhen(rev.createdAt, locale)}</span>
                <span className="text-xs text-ink-soft">{authorLabel(rev.author, t)}</span>
                {rev.seq ? (
                  <Link href={`/control-plane/knowledge/${connectorId}/changes/${rev.seq}`} className="text-xs text-coral-deep hover:underline">
                    #{rev.seq}
                    {rev.logTitle ? ` ${rev.logTitle}` : ''}
                  </Link>
                ) : null}
                {rev.current ? <Badge tone="success">{t('timeline.current')}</Badge> : null}
                {rev.status === 'archived' ? <Badge tone="neutral">{t('timeline.archived')}</Badge> : null}
                {rev.erased ? <Badge tone="danger">{t('timeline.erased')}</Badge> : null}
                {rev.tags.map((tag) => (
                  <Badge key={tag} tone="warning">
                    {tag}
                  </Badge>
                ))}
              </div>
              {rev.legacy ? <p className="mt-0.5 text-xs text-ink-faint">{t('timeline.legacy')}</p> : null}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                {!rev.erased ? (
                  <Link href={wikiHref(connectorId, { page: path, rev: String(rev.version) })} className="text-coral-deep hover:underline">
                    {rev.current ? t('timeline.openCurrent') : t('timeline.open')}
                  </Link>
                ) : (
                  <span className="text-ink-faint">{t('erasedNote')}</span>
                )}
                {previous && !rev.erased && !previous.erased ? (
                  <Link
                    href={wikiHref(connectorId, { page: path, from: String(previous.version), to: String(rev.version) })}
                    className="text-coral-deep hover:underline"
                  >
                    {t('timeline.compareWithPrevious')}
                  </Link>
                ) : null}
                {!rev.current && !rev.erased && history.canRevert ? (
                  <WikiRevertButton
                    connectorId={connectorId}
                    target={{ kind: 'page', path, version: rev.version }}
                    previewHref={wikiHref(connectorId, { page: path, from: String(rev.version), to: String(history.currentVersion) })}
                  />
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
      {ordered.length > 1 ? (
        <form method="get" action={`/control-plane/knowledge/${connectorId}`} className="mt-3 flex flex-wrap items-end gap-2 text-xs" data-testid="wiki-compare-form">
          <input type="hidden" name="page" value={path} />
          <label>
            <span className="mb-0.5 block text-ink-soft">{t('compare.from')}</span>
            <select name="from" defaultValue={String(ordered[Math.min(1, ordered.length - 1)].version)} className="rounded-md border border-line/70 px-2 py-1">
              {ordered.filter((rev) => !rev.erased).map((rev) => (
                <option key={rev.version} value={rev.version}>
                  v{rev.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-0.5 block text-ink-soft">{t('compare.to')}</span>
            <select name="to" defaultValue={String(ordered[0].version)} className="rounded-md border border-line/70 px-2 py-1">
              {ordered.filter((rev) => !rev.erased).map((rev) => (
                <option key={rev.version} value={rev.version}>
                  v{rev.version}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded-md border border-line px-2 py-1 font-medium text-ink hover:border-coral/60">
            {t('compare.submit')}
          </button>
        </form>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Korábbi verzió olvasásra + két verzió összevetése

export async function RevisionView({
  connectorId,
  path,
  version,
  locale,
}: {
  connectorId: string
  path: string
  version: string
  locale: string
}) {
  const t = await getTranslations('ControlPlane.wiki.history')
  const res = await getWikiRevisionAction({ connectorId, path, version })
  if (!res.success) {
    return (
      <Card>
        <p className="text-sm text-ink-soft">{t('versionNotFound')}</p>
      </Card>
    )
  }
  const rev = res.data
  const isCurrent = rev.version === rev.currentVersion
  return (
    <Card>
      <article data-testid="wiki-revision">
        {!isCurrent ? (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="wiki-old-version-banner">
            <span>{t('oldVersion.banner', { when: formatWhen(rev.createdAt, locale), version: rev.version })}</span>
            <Link href={wikiHref(connectorId, { page: path })} className="font-medium text-coral-deep hover:underline">
              {t('oldVersion.openCurrent')}
            </Link>
            <Link
              href={wikiHref(connectorId, { page: path, from: String(rev.version), to: String(rev.currentVersion) })}
              className="font-medium text-coral-deep hover:underline"
            >
              {t('oldVersion.compareWithCurrent')}
            </Link>
            {rev.canRevert ? (
              <WikiRevertButton connectorId={connectorId} target={{ kind: 'page', path, version: rev.version }} label={t('oldVersion.restore')} />
            ) : null}
          </div>
        ) : null}
        {rev.erased ? (
          <p className="text-sm text-ink-soft" data-testid="wiki-revision-erased">
            {t('erasedNote')}
          </p>
        ) : (
          <>
            <p className="text-xs text-ink-faint">
              {rev.revisionPath ?? path} · v{rev.version} · {authorLabel(rev.author, t)}
            </p>
            <h2 className="mt-1 font-display text-2xl font-semibold">{rev.title}</h2>
            {rev.summary ? <p className="mt-1 text-ink-soft">{rev.summary}</p> : null}
            <div className="mt-4">
              <WikiMarkdown connectorId={connectorId} body={rev.body} />
            </div>
          </>
        )}
      </article>
    </Card>
  )
}

export async function RevisionDiffView({
  connectorId,
  path,
  from,
  to,
  locale,
}: {
  connectorId: string
  path: string
  from: string
  to: string
  locale: string
}) {
  const t = await getTranslations('ControlPlane.wiki.history')
  const res = await diffWikiRevisionsAction({ connectorId, path, from, to })
  if (!res.success) {
    return (
      <Card>
        <p className="text-sm text-ink-soft">{t('versionNotFound')}</p>
      </Card>
    )
  }
  const diff = res.data
  return (
    <Card>
      <div data-testid="wiki-revision-diff">
        <p className="text-xs text-ink-faint">{path}</p>
        <h2 className="mt-1 font-display text-xl font-semibold">
          {t('compare.title', { from: diff.from.version, to: diff.to.version })}
        </h2>
        <p className="mt-1 text-xs text-ink-faint">
          {formatWhen(diff.from.createdAt, locale)} → {formatWhen(diff.to.createdAt, locale)}
        </p>
        {diff.from.erased || diff.to.erased ? (
          <p className="mt-3 text-sm text-ink-soft">{t('erasedNote')}</p>
        ) : (
          <div className="mt-3">
            <FieldChanges fields={diff.fields} t={t} />
            <DiffRows rows={diff.diff as LineDiffRow[]} unchangedLabel={(count) => (count ? t('unchangedLines', { count }) : t('noTextChange'))} />
          </div>
        )}
        <Link href={wikiHref(connectorId, { page: path })} className="mt-3 inline-block text-sm text-coral-deep hover:underline">
          {t('oldVersion.openCurrent')}
        </Link>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// „Változások” fül (§5.1, §5.3, §5.5)

export async function ChangesTab({
  connectorId,
  query,
  locale,
}: {
  connectorId: string
  query: { author?: string; from?: string; to?: string; before?: string }
  locale: string
}) {
  const t = await getTranslations('ControlPlane.wiki.history')
  const res = await listWikiChangesAction({
    connectorId,
    author: query.author || undefined,
    from: query.from || undefined,
    to: query.to || undefined,
    beforeSeq: query.before && /^\d+$/.test(query.before) ? query.before : undefined,
  })
  if (!res.success) {
    return (
      <Card title={t('changes.title')}>
        <p className="text-sm text-ink-soft">{t('changes.unavailable')}</p>
      </Card>
    )
  }
  const data = res.data
  const base = `/control-plane/knowledge/${connectorId}`
  return (
    <div className="space-y-4">
      <Card title={t('timeTravel.title')}>
        <p className="mb-3 text-sm text-ink-soft">{t('timeTravel.intro')}</p>
        <div className="flex flex-wrap items-end gap-4">
          <form method="get" action={base} className="flex flex-wrap items-end gap-2 text-sm" data-testid="wiki-time-travel-form">
            <input type="hidden" name="tab" value="wiki" />
            <label>
              <span className="mb-0.5 block text-xs text-ink-soft">{t('timeTravel.date')}</span>
              <input type="date" name="asOf" required className="rounded-md border border-line/70 px-2 py-1" />
            </label>
            <button type="submit" className="rounded-md border border-line px-3 py-1 font-medium text-ink hover:border-coral/60">
              {t('timeTravel.show')}
            </button>
          </form>
          {data.tags.length ? (
            <form method="get" action={base} className="flex flex-wrap items-end gap-2 text-sm">
              <input type="hidden" name="tab" value="wiki" />
              <label>
                <span className="mb-0.5 block text-xs text-ink-soft">{t('timeTravel.tag')}</span>
                <select name="asOf" className="rounded-md border border-line/70 px-2 py-1">
                  {data.tags.map((tag) => (
                    <option key={tag.id} value={String(tag.seq)}>
                      {tag.name} (#{tag.seq})
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="rounded-md border border-line px-3 py-1 font-medium text-ink hover:border-coral/60">
                {t('timeTravel.show')}
              </button>
            </form>
          ) : null}
        </div>
        {data.tags.length ? (
          <div className="mt-4" data-testid="wiki-tags">
            <p className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">{t('tags.title')}</p>
            <ul className="space-y-1 text-sm">
              {data.tags.map((tag) => (
                <li key={tag.id} className="flex flex-wrap items-center gap-2">
                  <Badge tone="warning">{tag.name}</Badge>
                  <span className="text-xs text-ink-faint">#{tag.seq} · {formatWhen(tag.createdAt, locale)}</span>
                  {tag.note ? <span className="text-xs text-ink-soft">{tag.note}</span> : null}
                  <Link href={wikiHref(connectorId, { tab: 'wiki', asOf: String(tag.seq) })} className="text-xs text-coral-deep hover:underline">
                    {t('tags.view')}
                  </Link>
                  <a href={`/api/control-plane/knowledge/${connectorId}/export?tag=${encodeURIComponent(tag.name)}`} className="text-xs text-coral-deep hover:underline">
                    {t('tags.export')}
                  </a>
                  {data.canTag ? <WikiTagDeleteButton connectorId={connectorId} tagId={tag.id} name={tag.name} /> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <Card title={t('changes.title')}>
        <p className="mb-3 text-sm text-ink-soft">{t('changes.intro')}</p>
        <form method="get" action={base} className="mb-4 flex flex-wrap items-end gap-2 text-sm" data-testid="wiki-changes-filter">
          <input type="hidden" name="tab" value="changes" />
          <label>
            <span className="mb-0.5 block text-xs text-ink-soft">{t('changes.author')}</span>
            <select name="author" defaultValue={query.author ?? ''} className="rounded-md border border-line/70 px-2 py-1">
              <option value="">{t('changes.anyAuthor')}</option>
              {data.authors.map((row) => (
                <option key={row.key} value={row.key}>
                  {authorLabel(row, t)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-0.5 block text-xs text-ink-soft">{t('changes.from')}</span>
            <input type="date" name="from" defaultValue={query.from ?? ''} className="rounded-md border border-line/70 px-2 py-1" />
          </label>
          <label>
            <span className="mb-0.5 block text-xs text-ink-soft">{t('changes.to')}</span>
            <input type="date" name="to" defaultValue={query.to ?? ''} className="rounded-md border border-line/70 px-2 py-1" />
          </label>
          <button type="submit" className="rounded-md border border-line px-3 py-1 font-medium text-ink hover:border-coral/60">
            {t('changes.filter')}
          </button>
        </form>
        {data.changes.length === 0 ? (
          <p className="text-sm text-ink-soft" data-testid="wiki-changes-empty">
            {t('changes.empty')}
          </p>
        ) : (
          <ol className="space-y-3" data-testid="wiki-changes">
            {data.changes.map((change) => (
              <li key={change.seq} className="rounded-lg border border-line/60 px-3 py-2" data-testid="wiki-change-row">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <Link href={`${base}/changes/${change.seq}`} className="font-medium text-coral-deep hover:underline">
                    #{change.seq}
                  </Link>
                  <span className="font-medium text-ink">{change.title ?? t('changes.untitled')}</span>
                  {change.status === 'reverted' ? (
                    <Badge tone="danger">{t('changes.reverted', { seq: change.revertedBySeq ?? '?' })}</Badge>
                  ) : null}
                  {change.revertsSeq ? <Badge tone="neutral">{t('changes.reverts', { seq: change.revertsSeq })}</Badge> : null}
                </div>
                <p className="text-xs text-ink-faint">
                  {change.appliedAt ? formatWhen(change.appliedAt, locale) : '—'} · {authorLabel(change.author, t)}
                </p>
                {change.note ? <p className="mt-0.5 text-xs text-ink-soft">{change.note}</p> : null}
                {change.pages.length ? (
                  <ul className="mt-1 flex flex-wrap gap-1 text-xs">
                    {change.pages.map((page) => (
                      <li key={`${page.path}-${page.action}`} className="rounded bg-ink/5 px-1.5 py-0.5 text-ink-soft">
                        {t(`actions.${page.action}`)} · {page.title || page.path}{' '}
                        <span className="text-sage">+{page.linesAdded}</span> <span className="text-coral-deep">−{page.linesRemoved}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Link href={wikiHref(connectorId, { tab: 'wiki', asOf: String(change.seq) })} className="text-xs text-coral-deep hover:underline">
                    {t('changes.stateAfter')}
                  </Link>
                  {data.canRevert && change.status === 'applied' ? (
                    <WikiRevertButton connectorId={connectorId} target={{ kind: 'changeset', seq: change.seq! }} previewHref={`${base}/changes/${change.seq}`} />
                  ) : null}
                  {data.canTag && change.seq ? <WikiTagForm connectorId={connectorId} seq={change.seq} /> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
        {data.nextBeforeSeq ? (
          <Link
            href={wikiHref(connectorId, {
              tab: 'changes',
              author: query.author,
              from: query.from,
              to: query.to,
              before: String(data.nextBeforeSeq),
            })}
            className="mt-3 inline-block text-sm text-coral-deep hover:underline"
          >
            {t('changes.older')}
          </Link>
        ) : null}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Change-set nézet (§5.1) — csak olvasó, innen indítható a visszavonás

export async function ChangeSetView({ connectorId, seq, locale }: { connectorId: string; seq: string; locale: string }) {
  const t = await getTranslations('ControlPlane.wiki.history')
  const res = await getWikiChangeSetAction({ connectorId, seq })
  if (!res.success) {
    return (
      <Card>
        <p className="text-sm text-ink-soft">{t('changeSet.notFound')}</p>
      </Card>
    )
  }
  const change = res.data
  return (
    <div className="space-y-4" data-testid="wiki-change-set">
      <Card>
        <p className="text-xs text-ink-faint">{t('changeSet.eyebrow', { seq: change.seq ?? '?' })}</p>
        <h2 className="mt-1 font-display text-2xl font-semibold">{change.logTitle ?? t('changes.untitled')}</h2>
        <p className="mt-1 text-sm text-ink-soft">
          {change.appliedAt ? formatWhen(change.appliedAt, locale) : '—'} · {authorLabel(change.author, t)}
        </p>
        {change.logNote ? <p className="mt-2 text-sm text-ink-soft">{change.logNote}</p> : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {change.status === 'reverted' ? (
            <Badge tone="danger">{t('changes.reverted', { seq: change.revertedBySeq ?? '?' })}</Badge>
          ) : null}
          {change.revertsSeq ? (
            <Link href={`/control-plane/knowledge/${connectorId}/changes/${change.revertsSeq}`}>
              <Badge tone="neutral">{t('changes.reverts', { seq: change.revertsSeq })}</Badge>
            </Link>
          ) : null}
          <Link href={wikiHref(connectorId, { tab: 'wiki', asOf: String(change.seq) })} className="text-sm text-coral-deep hover:underline">
            {t('changes.stateAfter')}
          </Link>
          {change.canRevert && change.seq ? (
            <WikiRevertButton connectorId={connectorId} target={{ kind: 'changeset', seq: change.seq }} />
          ) : null}
        </div>
      </Card>
      {change.pages.map((page) => (
        <Card key={`${page.pageId}-${page.version}`}>
          <article data-testid="wiki-change-set-page">
            <header className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone={page.action === 'created' ? 'success' : page.action === 'archived' ? 'danger' : 'neutral'}>
                {t(`actions.${page.action}`)}
              </Badge>
              <span className="font-medium text-ink">{page.title ?? t('timeline.erased')}</span>
              <code className="text-xs text-ink-faint">
                {page.fromPath ? `${page.fromPath} → ` : ''}
                {page.path}
              </code>
              {page.linesAdded !== null ? (
                <span className="text-xs">
                  <span className="text-sage">+{page.linesAdded}</span> <span className="text-coral-deep">−{page.linesRemoved}</span>
                </span>
              ) : null}
              {page.currentPath ? (
                <Link href={wikiHref(connectorId, { page: page.currentPath })} className="text-xs text-coral-deep hover:underline">
                  {t('changeSet.openPage')}
                </Link>
              ) : null}
            </header>
            {page.erased ? (
              <p className="text-sm text-ink-soft">{t('erasedNote')}</p>
            ) : (
              <>
                {page.prunedBefore ? <p className="mb-2 text-xs text-ink-faint">{t('changeSet.prunedBefore')}</p> : null}
                <FieldChanges fields={page.fields} t={t} />
                {page.action === 'archived' ? (
                  <p className="text-sm text-ink-soft">{t('changeSet.archived')}</p>
                ) : (
                  <DiffRows rows={page.diff as LineDiffRow[]} unchangedLabel={(count) => (count ? t('unchangedLines', { count }) : t('noTextChange'))} />
                )}
              </>
            )}
          </article>
        </Card>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Időutazás-sáv (§5.3)

export async function TimeTravelBanner({
  connectorId,
  seq,
  at,
  thinned,
  locale,
}: {
  connectorId: string
  seq: number
  at: string | null
  thinned: boolean
  locale: string
}) {
  const t = await getTranslations('ControlPlane.wiki.history')
  return (
    <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="wiki-time-travel-banner">
      <p>
        {seq === 0
          ? t('timeTravel.beforeFirst')
          : t('timeTravel.banner', { when: at ? formatWhen(at, locale) : '—', seq })}{' '}
        <Link href={wikiHref(connectorId)} className="font-medium text-coral-deep hover:underline">
          {t('timeTravel.backToNow')}
        </Link>
      </p>
      <p className="mt-0.5 text-xs">{t('timeTravel.readOnly')}</p>
      {thinned ? <p className="mt-0.5 text-xs">{t('timeTravel.thinned')}</p> : null}
    </div>
  )
}

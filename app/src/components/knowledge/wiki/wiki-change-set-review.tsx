'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { getWikiChangeSetReviewAction } from '@/app/actions/knowledge-wiki'
import { Badge } from '@/components/ui/shell'
import { collapseUnchanged, type LineDiffRow } from '@/lib/text-line-diff'
import { wikiHref } from './wiki-format'

const ISSUE_CODES = [
  'broken_link',
  'sensitive_data',
  'frontmatter_in_body',
  'missing_source',
  'unknown_source',
  'missing_source_date',
  'page_too_large',
  'invalid_path',
  'reserved_path',
  'invalid_type',
  'missing_field',
  'empty_page',
  'duplicate_path',
  'page_not_found',
  'path_taken',
  'section_not_found',
  'empty_patch',
] as const
type IssueCode = (typeof ISSUE_CODES)[number]
const isIssueCode = (code: string): code is IssueCode => (ISSUE_CODES as readonly string[]).includes(code)

type Review = Extract<Awaited<ReturnType<typeof getWikiChangeSetReviewAction>>, { success: true }>['data']

/**
 * #946 jóváhagyó kártya wiki-változáshoz: rövid összegzés a sorban, „Részletek”
 * gombra hárompaneles nézet (források · oldalankénti eltérés · validáció).
 */
export function WikiChangeSetReview({
  changeSetId,
  busy,
  onApprove,
  onReject,
}: {
  changeSetId: string
  busy: boolean
  onApprove: () => void
  onReject: () => void
}) {
  const t = useTranslations('ControlPlane.wiki')
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getWikiChangeSetReviewAction({ changeSetId }).then((res) => {
      if (cancelled) return
      if (res.success) setReview(res.data)
      else setError(true)
    })
    return () => {
      cancelled = true
    }
  }, [changeSetId])

  if (error) return <p className="mt-1 text-sm text-ink-soft">{t('review.unavailable')}</p>
  if (!review) return <p className="mt-1 text-sm text-ink-faint">{t('review.loading')}</p>

  const errors = review.issues.filter((issue) => issue.severity === 'error')
  const warnings = review.issues.filter((issue) => issue.severity !== 'error')

  return (
    <div className="mt-1 space-y-2" data-testid="wiki-review-summary">
      <p className="text-sm text-ink">
        {t('review.headline', { agent: review.agentName ?? '—', wiki: review.wikiName, count: review.pages.length })}
      </p>
      <ul className="flex flex-wrap gap-1">
        {review.pages.map((page) => (
          <li key={page.path}>
            <ChangeBadge kind={page.kind} othersPage={page.othersPage} label={page.title} />
          </li>
        ))}
      </ul>
      {review.blocking ? (
        <p className="rounded-lg border border-coral/40 bg-coral/5 px-3 py-2 text-xs text-coral-deep">
          {t('review.blocking')}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="wiki-review-open"
        className="text-sm font-medium text-coral-deep hover:underline"
      >
        {t('review.details')}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('review.dialogTitle')}
          className="fixed inset-0 z-50 flex flex-col bg-ink/40 p-2 sm:p-6"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false)
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card shadow-xl" data-testid="wiki-review-dialog">
            <div className="flex flex-wrap items-center gap-2 border-b border-line/70 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-ink-faint">{t('review.dialogTitle')}</p>
                <p className="font-display text-lg font-semibold">
                  {review.wikiName}
                  {review.logTitle ? <span className="text-ink-soft"> · {review.logTitle}</span> : null}
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-line px-3 py-1.5 text-sm">
                {t('common.close')}
              </button>
            </div>
            <div className="grid min-h-0 flex-1 gap-0 overflow-hidden lg:grid-cols-[16rem_1fr_18rem]">
              <section className="min-h-0 overflow-auto border-b border-line/70 p-4 lg:border-b-0 lg:border-r">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">{t('review.sources')}</h3>
                {review.sources.length === 0 ? (
                  <p className="text-sm text-ink-soft">{t('review.noSources')}</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {review.sources.map((source) => (
                      <li key={source.documentId}>
                        <Link
                          href={wikiHref(review.connectorId, { source: source.documentId })}
                          target="_blank"
                          className="text-coral-deep hover:underline"
                        >
                          {source.filename}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                {review.logNote ? <p className="mt-4 text-xs text-ink-soft">{review.logNote}</p> : null}
              </section>
              <section className="min-h-0 overflow-auto p-4" data-testid="wiki-review-diff">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">{t('review.changes')}</h3>
                <div className="space-y-4">
                  {review.pages.map((page) => (
                    <PageDiff key={page.path} page={page} />
                  ))}
                </div>
              </section>
              <section className="min-h-0 overflow-auto border-t border-line/70 p-4 lg:border-l lg:border-t-0" data-testid="wiki-review-validation">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">{t('review.validation')}</h3>
                {errors.length === 0 && warnings.length === 0 ? (
                  <p className="text-sm text-sage">{t('review.validationOk')}</p>
                ) : null}
                <ul className="space-y-2 text-sm">
                  {[...errors, ...warnings].map((issue, index) => (
                    <li key={index} className={issue.severity === 'error' ? 'text-coral-deep' : 'text-amber-800'}>
                      <span className="font-medium">{issue.severity === 'error' ? t('review.error') : t('review.warning')}</span>
                      {issue.path ? <span className="text-ink-faint"> · {issue.path}</span> : null}
                      {isIssueCode(issue.code) ? (
                        <span className="block text-sm text-ink">{t(`review.issues.${issue.code}`)}</span>
                      ) : null}
                      {/* Az eredeti (angol, agentnek szóló) üzenet a részletekért. */}
                      <span className="block text-xs text-ink-faint">{issue.message}</span>
                    </li>
                  ))}
                </ul>
                {review.pages.some((page) => page.othersPage) ? (
                  <p className="mt-4 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    {t('review.othersPageNote')}
                  </p>
                ) : null}
              </section>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-line/70 px-4 py-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setOpen(false)
                  onReject()
                }}
                className="rounded-md border border-ink/20 px-3 py-1.5 text-sm text-ink disabled:opacity-50"
              >
                {t('review.reject')}
              </button>
              <button
                type="button"
                disabled={busy || !!review.blocking}
                data-testid="wiki-review-approve"
                onClick={() => {
                  setOpen(false)
                  onApprove()
                }}
                className="rounded-md bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {t('review.approve')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ChangeBadge({ kind, othersPage, label }: { kind: Review['pages'][number]['kind']; othersPage: boolean; label: string }) {
  const t = useTranslations('ControlPlane.wiki')
  const tone = othersPage ? 'warning' : kind === 'new' ? 'success' : kind === 'archived' ? 'danger' : 'neutral'
  return (
    <Badge tone={tone} title={othersPage ? t('review.othersPage') : undefined}>
      {t(`review.kind.${kind}`)} · {label}
    </Badge>
  )
}

function PageDiff({ page }: { page: Review['pages'][number] }) {
  const t = useTranslations('ControlPlane.wiki')
  const rows = collapseUnchanged(page.diff as LineDiffRow[])
  return (
    <article className={`rounded-lg border ${page.othersPage ? 'border-amber-400' : 'border-line/70'}`}>
      <header className="flex flex-wrap items-center gap-2 border-b border-line/70 px-3 py-2">
        <ChangeBadge kind={page.kind} othersPage={page.othersPage} label={page.title} />
        <code className="text-xs text-ink-faint">
          {page.path}
          {page.finalPath !== page.path ? ` → ${page.finalPath}` : ''}
        </code>
        {page.othersPage ? <span className="text-xs font-medium text-amber-800">{t('review.othersPage')}</span> : null}
      </header>
      {page.summary ? <p className="px-3 pt-2 text-xs text-ink-soft">{page.summary}</p> : null}
      {page.kind === 'archived' ? (
        <p className="px-3 py-2 text-sm text-ink-soft">{t('review.archivedBody')}</p>
      ) : (
        <pre className="max-h-96 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed">
          {rows.map((row, index) =>
            row.kind === 'skip' ? (
              <div key={index} className="text-ink-faint">
                {t('review.unchangedLines', { count: row.count })}
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
      )}
      {page.sources.length ? (
        <p className="border-t border-line/70 px-3 py-1.5 text-xs text-ink-faint">
          {t('review.pageSources')}{' '}
          {page.sources
            .map((ref) => `${ref.filename ?? ref.documentId}${ref.page ? ` (${t('page.pageN', { n: ref.page })})` : ''}`)
            .join(', ')}
        </p>
      ) : null}
    </article>
  )
}

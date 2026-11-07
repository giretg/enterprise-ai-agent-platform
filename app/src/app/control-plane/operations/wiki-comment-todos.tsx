'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import {
  acknowledgeWikiCommentAction,
  answerWikiCommentAction,
  reopenWikiCommentAction,
  type WikiCommentTodoRowData,
} from '@/app/actions/knowledge-wiki'
import { formatWhen, wikiHref } from '@/components/knowledge/wiki/wiki-format'
import { useWikiCommentErrorText } from '@/components/knowledge/wiki/wiki-comments'
import { WIKI_COMMENT_MAX_BODY } from '@/lib/wiki-comments'

const inputClass = 'w-full rounded-md border border-ink/15 bg-white px-2 py-1 text-sm text-ink'
const ghostButton = 'rounded-md border border-ink/20 px-3 py-1.5 text-sm text-ink disabled:opacity-50'
const solidButton = 'rounded-md bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50'

/** #1129 D10: a kommentek szerzőjének saját listája. Üresen nem jelenik meg, mint az új leveleké. */
export function WikiCommentTodos({ rows }: { rows: WikiCommentTodoRowData[] }) {
  const t = useTranslations('ControlPlane.operations.wikiComments')
  const router = useRouter()
  const errorText = useWikiCommentErrorText()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const resolved = rows.filter((row) => row.status === 'resolved')

  const run = (fn: () => Promise<{ success: boolean; error?: string }>) =>
    start(async () => {
      setError(null)
      const res = await fn()
      if (!res.success) setError(errorText(res.error))
      router.refresh()
    })

  if (rows.length === 0) return null
  return (
    <section className="space-y-4" data-testid="wiki-comment-todos">
      <div>
        <h2 className="font-display text-xl font-semibold">{t('title')}</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">{t('body')}</p>
      </div>
      {error ? <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</p> : null}
      <ul className="space-y-3">
        {rows.map((row) => (
          <TodoRow key={row.id} row={row} busy={pending} run={run} />
        ))}
      </ul>
      {resolved.length > 1 ? (
        <button type="button" className={ghostButton} disabled={pending} data-testid="wiki-comment-todo-all-ok" onClick={() => run(() => acknowledgeWikiCommentAction({ allResolved: true }))}>
          {t('allOk')}
        </button>
      ) : null}
    </section>
  )
}

function TodoRow({
  row,
  busy,
  run,
}: {
  row: WikiCommentTodoRowData
  busy: boolean
  run: (fn: () => Promise<{ success: boolean; error?: string }>) => void
}) {
  const t = useTranslations('ControlPlane.operations.wikiComments')
  const locale = useLocale()
  const [mode, setMode] = useState<null | 'answer' | 'reopen'>(null)
  const [text, setText] = useState('')
  const label = row.status === 'question' ? t('labelQuestion') : row.status === 'declined' ? t('labelDeclined') : t('labelResolved')
  return (
    <li className="rounded-xl border border-ink/10 bg-white/50 p-3 shadow-sm" data-testid="wiki-comment-todo" data-status={row.status}>
      <p className="text-sm font-medium text-coral-deep">{label}</p>
      <p className="text-sm text-ink">
        {row.wikiName} ·{' '}
        <Link href={wikiHref(row.connectorId, { page: row.path })} className="text-coral-deep hover:underline">
          {row.pageTitle}
        </Link>
      </p>
      <p className="text-xs text-ink-faint">{formatWhen(row.createdAt, locale)}</p>
      <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-ink-soft">{row.body}</p>
      {row.answer ? <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink" data-testid="wiki-comment-todo-answer">{row.answer}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {row.status === 'question' ? (
          <button type="button" className={solidButton} disabled={busy} data-testid="wiki-comment-todo-answer-open" onClick={() => setMode('answer')}>{t('answer')}</button>
        ) : (
          <button type="button" className={solidButton} disabled={busy} data-testid="wiki-comment-todo-ok" onClick={() => run(() => acknowledgeWikiCommentAction({ commentId: row.id }))}>{t('ok')}</button>
        )}
        {row.status === 'declined' ? (
          <button type="button" className={ghostButton} disabled={busy} data-testid="wiki-comment-todo-reopen" onClick={() => setMode('reopen')}>{t('reopen')}</button>
        ) : null}
        {row.status === 'resolved' && row.changeSeq ? (
          <Link href={`/control-plane/knowledge/${row.connectorId}/changes/${row.changeSeq}`} className={ghostButton}>{t('openChange')}</Link>
        ) : null}
      </div>
      {mode ? (
        <div className="mt-2 space-y-2">
          <textarea
            autoFocus
            rows={2}
            maxLength={WIKI_COMMENT_MAX_BODY}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t(mode === 'answer' ? 'answerPlaceholder' : 'reopenPlaceholder')}
            className={inputClass}
            data-testid="wiki-comment-todo-text"
          />
          <div className="flex gap-2">
            <button
              type="button"
              className={solidButton}
              disabled={busy || !text.trim()}
              data-testid="wiki-comment-todo-send"
              onClick={() =>
                run(() =>
                  mode === 'answer'
                    ? answerWikiCommentAction({ connectorId: row.connectorId, commentId: row.id, text })
                    : reopenWikiCommentAction({ connectorId: row.connectorId, commentId: row.id, reason: text }),
                )
              }
            >
              {t('send')}
            </button>
            <button type="button" className={ghostButton} onClick={() => setMode(null)}>{t('cancel')}</button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  addWikiCommentAction,
  answerWikiCommentAction,
  closeWikiCommentAction,
  deleteWikiCommentAction,
  reopenWikiCommentAction,
  withdrawWikiCommentAction,
} from '@/app/actions/knowledge-wiki'
import type { WikiCommentView } from '@/domain/knowledge-base/wiki-comment-service'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Badge } from '@/components/ui/shell'
import { WIKI_COMMENT_MAX_BODY, WIKI_COMMENT_MAX_QUOTE, WIKI_COMMENT_PARTLY_APPLIED, type WikiCommentStatusName } from '@/lib/wiki-comments'
import { formatWhen, wikiHref } from './wiki-format'

const inputClass = 'w-full rounded-lg border border-line/70 bg-card px-3 py-2 text-sm'
const ghostButton = 'rounded-lg border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-50'
const solidButton = 'rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50'

const ERROR_CODES = ['comment_not_open', 'comment_rate_limited', 'comment_sensitive_data', 'page_not_commentable', 'not_author', 'not_found', 'forbidden', 'invalid_args'] as const

/** A hibaüzenet megmondja, mi történt és mi a teendő (NFR-1). */
export function useWikiCommentErrorText() {
  const t = useTranslations('ControlPlane.wiki.comments.errors')
  return (code: string | undefined) => {
    const known = ERROR_CODES.find((item) => item === code)
    return known ? t(known) : t('generic')
  }
}

export function WikiCommentStatusBadge({ status }: { status: WikiCommentStatusName }) {
  const t = useTranslations('ControlPlane.wiki.comments')
  const tone = status === 'resolved' ? 'success' : status === 'open' || status === 'question' || status === 'pending_approval' ? 'warning' : 'neutral'
  return (
    <span className="inline-flex items-center" data-testid="wiki-comment-status" data-status={status}>
      <Badge tone={tone} title={t(`statusHelp.${status}`)}>{t(`statuses.${status}`)}</Badge>
      <HelpHint>{t(`statusHelp.${status}`)}</HelpHint>
    </span>
  )
}

type Thread = WikiCommentView['thread'][number]

function ThreadRow({ row, locale }: { row: Thread; locale: string }) {
  const t = useTranslations('ControlPlane.wiki.comments')
  const who = row.actor === 'system' ? t('system') : row.actor === 'agent' ? row.actorName ?? t('agent') : row.actorName ?? t('unknownAuthor')
  const code = row.systemCode
  const partly = !!code && code.endsWith(`_${WIKI_COMMENT_PARTLY_APPLIED}`)
  const base = partly ? code!.slice(0, -WIKI_COMMENT_PARTLY_APPLIED.length - 1) : code
  return (
    <li className="border-l-2 border-line/70 pl-2" data-testid="wiki-comment-thread-row">
      <p className="text-xs text-ink-faint">
        {who} · {formatWhen(row.at, locale)}
      </p>
      {base ? (
        <p className="text-sm text-ink-soft">
          {t(`systemCodes.${base as 'change_rejected'}`)}
          {partly ? ` ${t('partlyAppliedSuffix')}` : ''}
        </p>
      ) : null}
      {row.text ? <p className="whitespace-pre-wrap break-words text-sm text-ink">{row.text}</p> : null}
    </li>
  )
}

type Mode = null | 'reply' | 'reopen' | 'close' | 'remove'

export function WikiCommentCard({
  connectorId,
  comment,
  canManage,
  userId,
  locale,
  showPage = false,
}: {
  connectorId: string
  comment: WikiCommentView
  canManage: boolean
  userId: string
  locale: string
  /** A Kommentek fülön az oldal is látszik. */
  showPage?: boolean
}) {
  const t = useTranslations('ControlPlane.wiki.comments')
  const errorText = useWikiCommentErrorText()
  const router = useRouter()
  const [pending, start] = useTransition()
  const [mode, setMode] = useState<Mode>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const run = (fn: () => Promise<{ success: boolean; error?: string }>) =>
    start(async () => {
      setError(null)
      const res = await fn()
      if (!res.success) {
        setError(errorText(res.error))
        return
      }
      setMode(null)
      setText('')
      router.refresh()
    })

  if (comment.erased) {
    return (
      <li className="rounded-lg border border-dashed border-line/70 px-3 py-2 text-sm text-ink-faint" data-testid="wiki-comment-erased">
        {t('erased')}
      </li>
    )
  }

  const isAuthor = comment.author.userId === userId
  const canWithdraw = isAuthor && (comment.status === 'open' || comment.status === 'question')
  const canReply = comment.status === 'question'
  const canReopen = (isAuthor || canManage) && (comment.status === 'resolved' || comment.status === 'declined')
  const canClose = canManage && (comment.status === 'open' || comment.status === 'question')

  return (
    <li className="rounded-lg border border-line/70 px-3 py-2" data-testid="wiki-comment">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{comment.author.name ?? t('unknownAuthor')}</span>
        <span className="text-xs text-ink-faint">{formatWhen(comment.createdAt, locale)}</span>
        <WikiCommentStatusBadge status={comment.status} />
        {showPage ? (
          <Link href={wikiHref(connectorId, { page: comment.path })} className="text-xs text-coral-deep hover:underline">
            {comment.pageTitle}
          </Link>
        ) : null}
      </div>
      {comment.quote ? (
        <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 border-line pl-2 text-sm text-ink-soft" data-testid="wiki-comment-quote">
          {comment.quote}
        </blockquote>
      ) : null}
      {/* S7: sima szöveg; a törzsben lévő HTML és Markdown nem értelmeződik. */}
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink" data-testid="wiki-comment-body">{comment.body}</p>
      {comment.pageChangedSinceComment ? (
        <p className="mt-1 text-xs text-ink-faint">{t('versionNote', { version: comment.pageVersionAtComment })}</p>
      ) : null}
      {comment.thread.length ? (
        <ul className="mt-2 space-y-1.5" data-testid="wiki-comment-thread">
          {comment.thread.map((row) => (
            <ThreadRow key={row.id} row={row} locale={locale} />
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        {comment.changeSeq ? (
          <Link href={`/control-plane/knowledge/${connectorId}/changes/${comment.changeSeq}`} className="text-coral-deep hover:underline" data-testid="wiki-comment-change">
            {t('openChange')}
          </Link>
        ) : null}
        {canReply ? <button type="button" className={ghostButton} onClick={() => setMode('reply')} data-testid="wiki-comment-reply">{t('reply')}</button> : null}
        {canReopen ? <button type="button" className={ghostButton} onClick={() => setMode('reopen')} data-testid="wiki-comment-reopen">{t('reopen')}</button> : null}
        {canClose ? <button type="button" className={ghostButton} onClick={() => setMode('close')} data-testid="wiki-comment-close">{t('close')}</button> : null}
        {canWithdraw ? (
          <button
            type="button"
            className={ghostButton}
            disabled={pending}
            data-testid="wiki-comment-withdraw"
            onClick={() => run(() => withdrawWikiCommentAction({ connectorId, commentId: comment.id }))}
          >
            {t('withdraw')}
          </button>
        ) : null}
        {canManage ? <button type="button" className={ghostButton} onClick={() => setMode('remove')} data-testid="wiki-comment-delete">{t('remove')}</button> : null}
      </div>
      {mode === 'remove' ? (
        <div className="mt-2 space-y-2 rounded-lg border border-line/70 p-2 text-sm">
          <p className="text-ink-soft">{t('removeConfirm')}</p>
          <div className="flex gap-2">
            <button type="button" className={solidButton} disabled={pending} data-testid="wiki-comment-delete-confirm" onClick={() => run(() => deleteWikiCommentAction({ connectorId, commentId: comment.id }))}>
              {t('remove')}
            </button>
            <button type="button" className={ghostButton} onClick={() => setMode(null)}>{t('cancel')}</button>
          </div>
        </div>
      ) : null}
      {mode === 'reply' || mode === 'reopen' || mode === 'close' ? (
        <div className="mt-2 space-y-2">
          <textarea
            autoFocus
            rows={2}
            maxLength={WIKI_COMMENT_MAX_BODY}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t(mode === 'reply' ? 'replyPlaceholder' : mode === 'reopen' ? 'reopenPlaceholder' : 'closePlaceholder')}
            className={inputClass}
            data-testid="wiki-comment-action-text"
          />
          <div className="flex flex-wrap gap-2">
            {mode === 'close' ? (
              <>
                <button type="button" className={solidButton} disabled={pending || !text.trim()} data-testid="wiki-comment-close-resolved" onClick={() => run(() => closeWikiCommentAction({ connectorId, commentId: comment.id, to: 'resolved', reason: text }))}>
                  {t('closeResolved')}
                </button>
                <button type="button" className={solidButton} disabled={pending || !text.trim()} data-testid="wiki-comment-close-declined" onClick={() => run(() => closeWikiCommentAction({ connectorId, commentId: comment.id, to: 'declined', reason: text }))}>
                  {t('closeDeclined')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className={solidButton}
                disabled={pending || !text.trim()}
                data-testid="wiki-comment-action-send"
                onClick={() =>
                  run(() =>
                    mode === 'reply'
                      ? answerWikiCommentAction({ connectorId, commentId: comment.id, text })
                      : reopenWikiCommentAction({ connectorId, commentId: comment.id, reason: text }),
                  )
                }
              >
                {t('confirm')}
              </button>
            )}
            <button type="button" className={ghostButton} onClick={() => setMode(null)}>{t('cancel')}</button>
          </div>
        </div>
      ) : null}
      {error ? <p className="mt-1 text-sm text-coral-deep" role="alert">{error}</p> : null}
    </li>
  )
}

/** Az oldal alatti panel: az olvasó fülön is, mert ott olvasnak az emberek. */
export function WikiCommentsPanel({
  connectorId,
  path,
  comments,
  canComment,
  canManage,
  userId,
  hasWriter,
  locale,
}: {
  connectorId: string
  path: string
  comments: WikiCommentView[]
  canComment: boolean
  canManage: boolean
  userId: string
  hasWriter: boolean
  locale: string
}) {
  const t = useTranslations('ControlPlane.wiki.comments')
  const errorText = useWikiCommentErrorText()
  const router = useRouter()
  const [pending, start] = useTransition()
  const [body, setBody] = useState('')
  const [quote, setQuote] = useState('')
  const [selection, setSelection] = useState('')
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)

  // Az oldal szövegéből kijelölt rész idézetként a kommentbe tehető; a horgony szándékosan nincs (D1).
  useEffect(() => {
    if (!canComment) return
    const update = () => {
      const current = document.getSelection()
      const anchor = current?.anchorNode
      const inside = !!anchor && !!(anchor instanceof Element ? anchor : anchor.parentElement)?.closest('[data-wiki-comment-scope]')
      setSelection(inside && current ? current.toString().trim().slice(0, WIKI_COMMENT_MAX_QUOTE) : '')
    }
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [canComment])

  const send = () =>
    start(async () => {
      setError(null)
      const res = await addWikiCommentAction({ connectorId, path, body, quote: quote || undefined })
      if (!res.success) {
        setError(errorText(res.error))
        return
      }
      setBody('')
      setQuote('')
      router.refresh()
    })

  return (
    <section id="wiki-comments" className="mt-6 scroll-mt-4 border-t border-line/70 pt-3" data-testid="wiki-comments-panel">
      <h3 className="mb-1 font-display text-lg font-semibold">{t('panelTitle')}</h3>
      {canComment ? (
        <div className="rounded-lg border border-line/70 bg-paper/60 px-3 py-2">
          <p className="text-sm text-ink-soft">{t('panelIntro')}</p>
          {quote ? (
            <div className="mt-2 flex items-start gap-2" data-testid="wiki-comment-draft-quote">
              <blockquote className="min-w-0 flex-1 whitespace-pre-wrap break-words border-l-2 border-line pl-2 text-sm text-ink-soft">
                <span className="block text-xs text-ink-faint">{t('quoteLabel')}</span>
                {quote}
              </blockquote>
              <button type="button" onClick={() => setQuote('')} className="text-xs text-ink-soft hover:text-ink">{t('quoteRemove')}</button>
            </div>
          ) : null}
          <textarea
            ref={field}
            rows={3}
            maxLength={WIKI_COMMENT_MAX_BODY}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={t('placeholder')}
            className={`${inputClass} mt-2`}
            data-testid="wiki-comment-input"
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button type="button" className={solidButton} disabled={pending || !body.trim()} onClick={send} data-testid="wiki-comment-send">
              {t('send')}
            </button>
            <span className="text-xs text-ink-faint">{t('sendHint')}</span>
          </div>
          {error ? <p className="mt-1 text-sm text-coral-deep" role="alert" data-testid="wiki-comment-error">{error}</p> : null}
        </div>
      ) : (
        <p className="text-sm text-ink-soft">{t('notCommentable')}</p>
      )}
      {selection ? (
        <button
          type="button"
          className={`fixed bottom-6 right-6 z-40 shadow-lg ${solidButton}`}
          data-testid="wiki-comment-quote-selection"
          // Az egérlenyomás ne szüntesse meg a kijelölést a kattintás előtt.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setQuote(selection)
            setSelection('')
            field.current?.focus()
            field.current?.scrollIntoView({ block: 'center' })
          }}
        >
          {t('quoteSelection')}
        </button>
      ) : null}
      {!hasWriter ? (
        <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="wiki-comment-no-writer">
          {t('noWriter')}{' '}
          {canManage ? (
            <Link href={wikiHref(connectorId, { tab: 'access' })} className="font-medium underline">
              {t('noWriterLink')}
            </Link>
          ) : null}
        </p>
      ) : null}
      {comments.length === 0 ? (
        <p className="mt-3 text-sm text-ink-soft" data-testid="wiki-comments-empty">{t('empty')}</p>
      ) : (
        <ul className="mt-3 space-y-2" data-testid="wiki-comments-list">
          {comments.map((comment) => (
            <WikiCommentCard key={comment.id} connectorId={connectorId} comment={comment} canManage={canManage} userId={userId} locale={locale} />
          ))}
        </ul>
      )}
    </section>
  )
}

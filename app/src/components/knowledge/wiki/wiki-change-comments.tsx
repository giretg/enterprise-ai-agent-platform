'use client'

import { useTranslations } from 'next-intl'
import { HelpHint } from '@/components/onboarding/onboarding-ui'

export type WikiChangeComment = {
  id: string
  path: string
  authorName: string | null
  quote: string | null
  body: string
  erased: boolean
  note: string | null
}

/**
 * #1129 S3: a jóváhagyó és a változásnézet a kérést és a módosítást együtt látja. A szöveg sima
 * szövegként jelenik meg, mert bizalmatlan bemenet (S7).
 */
export function WikiChangeComments({ comments }: { comments: WikiChangeComment[] }) {
  const t = useTranslations('ControlPlane.wiki.comments')
  if (comments.length === 0) return null
  return (
    <section className="rounded-lg border border-line/70 bg-paper/60 px-3 py-2" data-testid="wiki-change-comments">
      <p className="flex items-center text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
        {t('review.title')}
        <HelpHint>{t('review.help')}</HelpHint>
      </p>
      <ul className="mt-1 space-y-2 text-sm">
        {comments.map((comment) => (
          <li key={comment.id}>
            {comment.erased ? (
              <p className="text-ink-faint">{t('review.erased')}</p>
            ) : (
              <>
                <p className="text-xs text-ink-faint">
                  {comment.authorName ?? t('unknownAuthor')} · {comment.path}
                </p>
                {comment.quote ? (
                  <blockquote className="mt-0.5 whitespace-pre-wrap break-words border-l-2 border-line pl-2 text-xs text-ink-soft">{comment.quote}</blockquote>
                ) : null}
                <p className="whitespace-pre-wrap break-words text-ink">{comment.body}</p>
                {comment.note ? <p className="whitespace-pre-wrap break-words text-xs text-ink-soft">{t('review.note', { note: comment.note })}</p> : null}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

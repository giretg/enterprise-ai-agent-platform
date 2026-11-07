'use client'

import { useTranslations } from 'next-intl'
import { WIKI_COMMENT_STATUSES } from '@/lib/wiki-comments'

/** A hat állapot rövid magyarázata a Kommentek fülön (NFR-1). */
export function WikiCommentStateGuide() {
  const t = useTranslations('ControlPlane.wiki.comments')
  return (
    <details className="mt-2 text-sm" data-testid="wiki-comments-states">
      <summary className="cursor-pointer font-medium text-ink">{t('tab.statesTitle')}</summary>
      <dl className="mt-1 space-y-1">
        {WIKI_COMMENT_STATUSES.map((status) => (
          <div key={status} className="flex flex-wrap gap-x-2">
            <dt className="font-medium text-ink">{t(`statuses.${status}`)}</dt>
            <dd className="text-ink-soft">{t(`statusHelp.${status}`)}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

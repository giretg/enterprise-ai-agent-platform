'use client'

import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslations } from 'next-intl'
import { linkifyWikiLinks } from '@/lib/wiki-markdown-links'
import { wikiHref } from './wiki-format'

export function WikiMarkdown({
  connectorId,
  body,
  knownPaths,
  linkQuery,
}: {
  connectorId: string
  body: string
  /** Hiányában (pl. korábbi verzió) nem jelöljük a nem létező oldalakat. */
  knownPaths?: string[]
  /** #978: időutazásban a linkek is az adott állapotra mutatnak. */
  linkQuery?: Record<string, string>
}) {
  const t = useTranslations('ControlPlane.wiki')
  const known = knownPaths ? new Set(knownPaths) : null
  return (
    <div className="wiki-markdown space-y-3 text-sm leading-relaxed text-ink [&_a]:text-coral-deep [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-ink/5 [&_code]:px-1 [&_h1]:font-display [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:font-display [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line/70 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line/70 [&_th]:bg-paper [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            if (href?.startsWith('#wiki:')) {
              const path = decodeURIComponent(href.slice('#wiki:'.length))
              const exists = !known || known.has(path)
              return (
                <Link
                  href={wikiHref(connectorId, { ...linkQuery, page: path })}
                  className={exists ? undefined : 'opacity-60'}
                  title={exists ? path : t('page.missingLink', { path })}
                >
                  {children}
                </Link>
              )
            }
            const external = !!href && /^https?:\/\//i.test(href)
            return (
              <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                {children}
              </a>
            )
          },
        }}
      >
        {linkifyWikiLinks(body)}
      </ReactMarkdown>
    </div>
  )
}

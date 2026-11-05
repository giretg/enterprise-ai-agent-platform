'use client'

import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslations } from 'next-intl'
import { linkifyWikiLinks, resolveRelativeWikiLink } from '@/lib/wiki-markdown-links'
import { wikiHref } from './wiki-format'

export function WikiMarkdown({
  connectorId,
  body,
  pagePath,
  knownPaths,
  linkTitles,
  linkQuery,
  crossLinkQuery,
  crossLinks,
}: {
  connectorId: string
  body: string
  /** A megjelenített oldal útvonala: ehhez képest oldódik fel a relatív `.md` link. */
  pagePath: string
  /** Hiányában (pl. korábbi verzió) nem jelöljük a nem létező oldalakat. */
  knownPaths?: string[]
  /** A címke nélküli `[[path]]` link felirata; hiányában az útvonal. */
  linkTitles?: Record<string, string>
  /** #978: időutazásban a linkek is az adott állapotra mutatnak. */
  linkQuery?: Record<string, string>
  /** Másik wikibe mutató link query-je: az időutazás nem, az olvasó nézet átvihető. */
  crossLinkQuery?: Record<string, string>
  /** #1061 F2: `[[wiki:…]]` célok — `connectorId: null` = a néző nem látja azt a wikit. */
  crossLinks?: Array<{ wikiId: string; path: string; connectorId: string | null; exists: boolean; title?: string | null }>
}) {
  const t = useTranslations('ControlPlane.wiki')
  const known = knownPaths ? new Set(knownPaths) : null
  const titles: Record<string, string> = { ...linkTitles }
  for (const link of crossLinks ?? []) {
    if (link.title) titles[`wiki:${link.wikiId}/${link.path}`] = link.title
  }
  return (
    <div className="wiki-markdown space-y-3 text-sm leading-relaxed text-ink [&_a]:text-coral-deep [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-ink/5 [&_code]:px-1 [&_h1]:font-display [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:font-display [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line/70 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line/70 [&_th]:bg-paper [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            if (href?.startsWith('#xwiki:')) {
              const raw = href.slice('#xwiki:'.length)
              const slash = raw.indexOf('/')
              const wikiId = raw.slice(0, slash)
              const path = decodeURIComponent(raw.slice(slash + 1))
              const target = crossLinks?.find((link) => link.wikiId === wikiId && link.path === path)
              if (!target?.connectorId) {
                return (
                  <span className="text-ink-faint" title={t('page.crossLinkNoAccess')} data-testid="wiki-cross-link-restricted">
                    {children} ({t('page.crossLinkNoAccess')})
                  </span>
                )
              }
              return (
                <Link
                  href={wikiHref(target.connectorId, { ...crossLinkQuery, page: path })}
                  className={target.exists ? undefined : 'opacity-60'}
                  title={target.exists ? path : t('page.missingLink', { path })}
                >
                  {children}
                </Link>
              )
            }
            const path = href?.startsWith('#wiki:')
              ? decodeURIComponent(href.slice('#wiki:'.length))
              : href
                ? resolveRelativeWikiLink(pagePath, href)
                : null
            if (path) {
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
        {linkifyWikiLinks(body, titles)}
      </ReactMarkdown>
    </div>
  )
}

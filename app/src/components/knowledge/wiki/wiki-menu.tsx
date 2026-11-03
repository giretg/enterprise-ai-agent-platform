import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { wikiHref } from './wiki-format'

type MenuPage = { path: string; title: string; summary: string }
type MenuGroup = {
  key: string
  /** `null` = kategória nélküli oldalak („Egyéb”). */
  name: string | null
  description: string | null
  protected: boolean
  pageCount: number
  pages: MenuPage[]
  children: Array<Omit<MenuGroup, 'children'>>
}

/**
 * #1061 F1: a wiki bal oldali menüje — kétszintű, összecsukható, oldalszámmal.
 * Az aktuális oldal csoportja nyitva marad; kevés csoportnál minden nyitva.
 */
export async function WikiMenu({
  connectorId,
  groups,
  currentPath,
}: {
  connectorId: string
  groups: MenuGroup[]
  currentPath?: string
}) {
  const t = await getTranslations('ControlPlane.wiki.toc')
  const openAll = groups.length <= 6
  const contains = (group: Pick<MenuGroup, 'pages'> & { children?: MenuGroup['children'] }): boolean =>
    !!currentPath &&
    (group.pages.some((page) => page.path === currentPath) || (group.children ?? []).some((child) => contains(child)))

  const pageList = (pages: MenuPage[]) =>
    pages.length ? (
      <ul className="mt-1 space-y-0.5">
        {pages.map((page) => (
          <li key={page.path}>
            <Link
              href={wikiHref(connectorId, { page: page.path })}
              className={`block truncate rounded px-1.5 py-0.5 text-sm hover:bg-coral/5 ${
                currentPath === page.path ? 'bg-coral/10 font-medium text-coral-deep' : 'text-ink'
              }`}
              title={page.summary}
            >
              {page.title}
            </Link>
          </li>
        ))}
      </ul>
    ) : null

  const heading = (group: Omit<MenuGroup, 'children'>, level: 1 | 2) => (
    <summary
      className={`flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-0.5 hover:bg-ink/5 ${
        level === 1
          ? 'text-xs font-medium uppercase tracking-[0.14em] text-ink-faint'
          : 'text-xs font-medium text-ink-soft'
      }`}
      title={group.description ?? undefined}
    >
      <span
        aria-hidden
        className={`inline-block w-3 text-ink-faint transition-transform ${
          level === 1 ? 'group-open/l1:rotate-90' : 'group-open/l2:rotate-90'
        }`}
      >
        ›
      </span>
      <span className="min-w-0 truncate">{group.name ?? t('uncategorized')}</span>
      {group.protected ? (
        <span className="text-[10px] normal-case tracking-normal text-amber-700" title={t('protected')}>
          ● {t('protectedShort')}
        </span>
      ) : null}
      <span className="ml-auto rounded-full bg-ink/5 px-1.5 text-[11px] normal-case tracking-normal text-ink-soft">
        {group.pageCount}
      </span>
    </summary>
  )

  return (
    <div className="space-y-2" data-testid="wiki-toc">
      {groups.map((group) => (
        <details key={group.key} className="group/l1" open={openAll || contains(group)} data-testid="wiki-toc-group">
          {heading(group, 1)}
          <div className="ml-3">
            {pageList(group.pages)}
            {group.children.map((child) => (
              <details key={child.key} className="group/l2 mt-1" open={openAll || contains(child)} data-testid="wiki-toc-subgroup">
                {heading(child, 2)}
                <div className="ml-3">
                  {child.pages.length ? pageList(child.pages) : <p className="px-1.5 py-0.5 text-xs text-ink-faint">{t('emptyCategory')}</p>}
                </div>
              </details>
            ))}
            {group.pages.length === 0 && group.children.length === 0 ? (
              <p className="px-1.5 py-0.5 text-xs text-ink-faint">{t('emptyCategory')}</p>
            ) : null}
          </div>
        </details>
      ))}
    </div>
  )
}

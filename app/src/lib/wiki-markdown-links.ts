/**
 * #946: a wiki-linkek egyetlen értelmezése. A felület megjelenítése és a szerver
 * linkellenőrzése / visszahivatkozása is ezt használja, ezért nem térhetnek el.
 */
const WIKI_LINK = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g

/** Az Obsidian táblában `[[path\|címke]]` alakot ír: a pipe előtti `\` nem része a célnak. */
function cleanWikiLinkTarget(raw: string): string {
  return raw.replace(/\s*\\\s*$/, '').trim()
}

/** A törzs `[[…]]` linkjeinek célja nyersen, a horgony és a címke nélkül. */
export function wikiLinkTargets(body: string): string[] {
  return [...body.matchAll(WIKI_LINK)].map((match) => cleanWikiLinkTarget(match[1]))
}

/**
 * Relatív `.md` markdown-link célja az oldal útvonalához képest; `null`, ha nem
 * wiki-oldalra mutat (külső cím, oldalon belüli horgony, más fájltípus).
 */
export function resolveRelativeWikiLink(fromPath: string, href: string): string | null {
  const target = href.split('#')[0].split('?')[0]
  if (!target || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target) || !target.endsWith('.md')) return null
  const baseDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const parts = (target.startsWith('/') || !baseDir ? [] : baseDir.split('/')).concat(target.split('/'))
  const stack: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

/** Az oldal címe markdown link szövegeként: a különleges jel (táblában a `|` is) nem hat. */
function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]|*_`<>~&]/g, '\\$&')
}

/**
 * `[[path|címke]]` → belső link; a hiányzó oldalra mutató link halványan jelenik meg.
 * Címke nélkül a `titles` szerinti oldalcím a felirat (kulcs: `entities/x.md`, másik
 * wikinél `wiki:<wikiId>/<path>`), ha az nem ismert, az útvonal.
 */
export function linkifyWikiLinks(body: string, titles?: Readonly<Record<string, string>>): string {
  const linkText = (label: string | undefined, titleKey: string, path: string) => {
    if (label !== undefined) return label.replace(/[[\]]/g, '')
    const title = titles?.[titleKey]
    return title ? escapeLinkText(title) : path.replace(/\.md$/, '').replace(/[[\]]/g, '')
  }
  return body.replace(WIKI_LINK, (_match, target: string, _anchor: string | undefined, label: string | undefined) => {
    const trimmed = cleanWikiLinkTarget(target)
    // #1061 F2: wikik közti link — `[[wiki:<wikiId>/<path>]]` → `#xwiki:<wikiId>/<path>`.
    const cross = /^wiki:\s*([0-9a-f-]{36})\/+(.+)$/i.exec(trimmed)
    if (cross) {
      const wikiId = cross[1].toLowerCase()
      const crossPath = cross[2].trim().endsWith('.md') ? cross[2].trim() : `${cross[2].trim()}.md`
      return `[${linkText(label, `wiki:${wikiId}/${crossPath}`, crossPath)}](#xwiki:${wikiId}/${encodeURIComponent(crossPath)})`
    }
    const path = trimmed.replace(/^\/+/, '')
    const file = path.endsWith('.md') ? path : `${path}.md`
    return `[${linkText(label, file, path)}](#wiki:${encodeURIComponent(file)})`
  })
}

/** #946: a wiki-oldal markdownjának előkészítése megjelenítéshez. */
const WIKI_LINK = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g

/** `[[path|címke]]` → belső link; a hiányzó oldalra mutató link halványan jelenik meg. */
export function linkifyWikiLinks(body: string): string {
  return body.replace(WIKI_LINK, (_match, target: string, _anchor: string | undefined, label: string | undefined) => {
    const trimmed = target.trim()
    // #1061 F2: wikik közti link — `[[wiki:<wikiId>/<path>]]` → `#xwiki:<wikiId>/<path>`.
    const cross = /^wiki:\s*([0-9a-f-]{36})\/+(.+)$/i.exec(trimmed)
    if (cross) {
      const crossPath = cross[2].trim().endsWith('.md') ? cross[2].trim() : `${cross[2].trim()}.md`
      const text = (label ?? crossPath.replace(/\.md$/, '')).replace(/[[\]]/g, '')
      return `[${text}](#xwiki:${cross[1].toLowerCase()}/${encodeURIComponent(crossPath)})`
    }
    const path = trimmed.replace(/^\/+/, '')
    const file = path.endsWith('.md') ? path : `${path}.md`
    const text = (label ?? path.replace(/\.md$/, '')).replace(/[[\]]/g, '')
    return `[${text}](#wiki:${encodeURIComponent(file)})`
  })
}

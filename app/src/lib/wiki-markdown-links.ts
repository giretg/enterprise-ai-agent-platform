/** #946: a wiki-oldal markdownjának előkészítése megjelenítéshez. */
const WIKI_LINK = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g

/** `[[path|címke]]` → belső link; a hiányzó oldalra mutató link halványan jelenik meg. */
export function linkifyWikiLinks(body: string): string {
  return body.replace(WIKI_LINK, (_match, target: string, _anchor: string | undefined, label: string | undefined) => {
    const path = target.trim().replace(/^\/+/, '')
    const file = path.endsWith('.md') ? path : `${path}.md`
    const text = (label ?? path.replace(/\.md$/, '')).replace(/[[\]]/g, '')
    return `[${text}](#wiki:${encodeURIComponent(file)})`
  })
}

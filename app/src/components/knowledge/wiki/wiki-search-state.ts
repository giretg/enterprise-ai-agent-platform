import type { KbTextTerm } from '@/lib/kb-text-match'

/** #1136 D8: a keresés állapota csak ebben a böngészőfülben él, a kereső szó URL-be nem kerül. */
export type WikiSearchState = {
  query: string
  /** A legutóbb megnyitott találat: újranyitáskor innen folytatható a lista. */
  opened?: string
  /** Az oldalon kiemelendő szavak: csak a keresésből érkező első megjelenítésig élnek. */
  highlight?: { path: string; terms: KbTextTerm[] }
}

/** A találat megnyitása után: az éppen nyitott oldal is kiemelhet, ha nincs lapváltás. */
export const WIKI_SEARCH_HIGHLIGHT_EVENT = 'wiki-search-highlight'
/** A sáv „Találatok” gombja: újranyitja a keresést. */
export const WIKI_SEARCH_OPEN_EVENT = 'wiki-search-open'

function storageKey(connectorId: string): string {
  return `wiki-search:${connectorId}`
}

export function readWikiSearchState(connectorId: string): WikiSearchState | null {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(storageKey(connectorId)) ?? 'null')
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as WikiSearchState).query !== 'string') return null
    return parsed as WikiSearchState
  } catch {
    return null
  }
}

export function writeWikiSearchState(connectorId: string, state: WikiSearchState): void {
  try {
    sessionStorage.setItem(storageKey(connectorId), JSON.stringify(state))
  } catch {
    // Tiltott tárhelynél csak a folytatás és a kiemelés marad el, a keresés működik.
  }
}

/**
 * Ha keresésből érkeztünk erre az oldalra, visszaadja a szavakat, és egyből törli őket:
 * menüből, linkről vagy a Vissza gombbal érkezve így nincs kiemelés és sáv.
 */
export function consumeWikiSearchHighlight(connectorId: string, path: string): { query: string; terms: KbTextTerm[] } | null {
  const state = readWikiSearchState(connectorId)
  if (state?.highlight?.path !== path) return null
  writeWikiSearchState(connectorId, { query: state.query, opened: state.opened })
  return { query: state.query, terms: state.highlight.terms }
}

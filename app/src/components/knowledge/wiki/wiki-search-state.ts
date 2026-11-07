/** #1136 D8: a keresés állapota csak ebben a böngészőfülben él, a kereső szó URL-be nem kerül. */
export type WikiSearchState = {
  query: string
  /** A legutóbb megnyitott találat: újranyitáskor innen folytatható a lista. */
  opened?: string
}

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
    // Tiltott tárhelynél csak a folytatás marad el, a keresés működik.
  }
}

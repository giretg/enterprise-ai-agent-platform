import { effectiveWorkProjectKey } from '@/lib/work-project'

/** A Projektek oldal munkafájl-nézete: megnyitja a projektet és a fájlt. */
export function workFilePagePath(projectKey: string | null | undefined, path: string): string {
  // %20 a szóközre (nem +): a chatprogramok és levelezők linkfelismerője is ezt bírja jobban.
  const query = [
    ['project', effectiveWorkProjectKey(projectKey)],
    ['tab', 'files'],
    ['file', path],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')
  return `/control-plane/projects?${query}`
}

/** Abszolút link az agentnek, hogy megoszthassa az emberrel (MCP-válaszban). */
export function workFileUrl(origin: string, projectKey: string | null | undefined, path: string): string {
  return `${origin.replace(/\/+$/, '')}${workFilePagePath(projectKey, path)}`
}

export type WorkFileDeepLink = { project: string | null; tab: 'memory' | 'files' | null; file: string | null }

/** A mélylink paramétereinek óvatos kiolvasása (ismeretlen érték → null). */
export function parseWorkFileDeepLink(params: {
  project?: string | string[]
  tab?: string | string[]
  file?: string | string[]
}): WorkFileDeepLink {
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)
  const project = one(params.project)?.trim().slice(0, 120) || null
  const tab = one(params.tab)
  const file = one(params.file)?.trim().slice(0, 500) || null
  return {
    project,
    tab: tab === 'files' || tab === 'memory' ? tab : file ? 'files' : null,
    file,
  }
}

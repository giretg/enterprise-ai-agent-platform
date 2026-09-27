/**
 * Tenant-level coding-folder hints (#729). Not a grant — the desktop app
 * opens/allows the path. Empty omit from snapshots so old contentHash stays.
 */
export const LOCAL_ROOTS_MAX = 8
export const LOCAL_ROOT_MAX_LEN = 512

export const LOCAL_ROOTS_INVALID =
  'Érvénytelen útvonal: soronként egy ~/… vagy abszolút útvonal (pl. ~/Projects/platform). Ne legyen a teljes home, ne tartalmazzon ..-t, és ne legyen relatív.'

export const LOCAL_ROOTS_DEFINITION_NOTE =
  'Candidate git locations across machines (laptop, office, WSL). Hints, not a grant, not ranked. On this host use only the paths that exist — typically one clone. If none exist, ask where the repo is on this computer. Instruction checkout stays in suggestedRoot; do not copy it into these repos. Company memory stays on MCP.'

export function isValidLocalRoot(path: string): boolean {
  if (path.length === 0 || path.length > LOCAL_ROOT_MAX_LEN) return false
  if (/[\\*\?\0]/.test(path)) return false
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return false
  if (path === '~' || path === '/' || path === '~/') return false
  if (path.startsWith('~/')) return path.length > 2
  if (path.startsWith('/')) return path.length > 1
  return false
}

export function parseLocalRoots(raw: string | readonly string[] | null | undefined): string[] {
  const lines = typeof raw === 'string' ? raw.split('\n') : [...(raw ?? [])]
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const path = line.trim()
    if (!path || path.startsWith('#')) continue
    if (!isValidLocalRoot(path)) throw new Error(LOCAL_ROOTS_INVALID)
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
    if (out.length > LOCAL_ROOTS_MAX) throw new Error(LOCAL_ROOTS_INVALID)
  }
  return out
}

export function serializeLocalRoots(paths: readonly string[]): string {
  return parseLocalRoots(paths).join('\n')
}

/** Snapshot field: omit when empty so unpublished agents keep their contentHash. */
export function snapshotLocalRoots(raw: string | null | undefined): string[] | undefined {
  const paths = parseLocalRoots(raw)
  return paths.length > 0 ? paths : undefined
}

export function localRootsDefinitionBlock(paths: readonly string[] | undefined): {
  localRoots: { note: string; paths: string[] }
} | Record<string, never> {
  if (!paths?.length) return {}
  return { localRoots: { note: LOCAL_ROOTS_DEFINITION_NOTE, paths: [...paths] } }
}

export function withLocalRootsMemoryNote(note: string, paths: readonly string[] | undefined): string {
  if (!paths?.length) return note
  return `${note} Candidate coding folders across machines: see localRoots on this response (always in full; not catalog items). Use only a path that exists on this host.`
}

export function localRootsCheckoutFile(paths: readonly string[]): {
  path: string
  content: string
} | null {
  if (paths.length === 0) return null
  return {
    path: '.enterprise-agent/local-roots.json',
    content: `${JSON.stringify(
      {
        schemaVersion: 1,
        paths,
        note: LOCAL_ROOTS_DEFINITION_NOTE,
      },
      null,
      2,
    )}\n`,
  }
}

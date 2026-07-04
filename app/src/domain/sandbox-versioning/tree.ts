import { createHash } from 'node:crypto'

/**
 * Determinisztikus commit-fa hash és sor-szintű diff (Feature-spec §4.1/§4.2, SV1/SV2).
 *
 * A fa-hash a fájllista + tartalom-hash függvénye: sorrend-független, mert a
 * bejegyzéseket `path` szerint rendezzük, mielőtt hashelnénk. Így ugyanaz a fa
 * mindig ugyanazt a `tree_hash`-t adja (SV1), és egy projekten belül két azonos
 * fa ütközik a `unique(tenant, project, tree_hash)` kényszeren.
 */

export interface TreeFileInput {
  path: string
  /** A fájl teljes tartalma (a File Editor / ContentResolver oldja fel a contentRef-et). */
  content: string
}

export interface TreeManifestEntry {
  path: string
  contentHash: string
  sizeBytes: number
  isBinary: boolean
}

export interface BuiltTree {
  entries: TreeManifestEntry[]
  treeHash: string
  fileCount: number
  totalSizeBytes: number
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Bináris heurisztika: NUL bájt jelenléte → nincs sor-szintű diff (§1.2/blob). */
export function isBinaryContent(content: string): boolean {
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0) return true
  }
  return false
}

/** Determinisztikus normalizálás a hash előtt (CRLF → LF), mint a SandboxApp-nál. */
function normalize(content: string): string {
  return content.replace(/\r\n/g, '\n')
}

export function buildTree(files: TreeFileInput[]): BuiltTree {
  const seen = new Set<string>()
  const entries: TreeManifestEntry[] = []
  let totalSizeBytes = 0

  for (const f of files) {
    const path = f.path.trim()
    if (!path) throw new Error('Empty file path in commit tree')
    if (seen.has(path)) throw new Error(`Duplicate file path in commit tree: ${path}`)
    seen.add(path)
    const content = normalize(f.content)
    const sizeBytes = Buffer.byteLength(content, 'utf8')
    entries.push({
      path,
      contentHash: sha256Hex(content),
      sizeBytes,
      isBinary: isBinaryContent(content),
    })
    totalSizeBytes += sizeBytes
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  // Length-prefixelt kanonikus alak: injektív a path/hash párokra, nem kell NUL
  // szeparátor a forrásban.
  const canonical = entries.map((e) => `${e.path.length}:${e.path}:${e.contentHash}`).join('\n')
  const treeHash = `sha256:${sha256Hex(canonical)}`

  return { entries, treeHash, fileCount: entries.length, totalSizeBytes }
}

export type FileChangeType = 'added' | 'modified' | 'deleted' | 'binary_changed'

export interface ChangedFile {
  path: string
  changeType: FileChangeType
  textDiff?: string
}

/** Minimalista sor-szintű diff (unified-szerű, kontextus nélkül) szöveges fájlokra. */
function textLineDiff(from: string, to: string): string {
  const a = normalize(from).split('\n')
  const b = normalize(to).split('\n')
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i]}`)
      i++
    } else {
      out.push(`+ ${b[j]}`)
      j++
    }
  }
  while (i < n) out.push(`- ${a[i++]}`)
  while (j < m) out.push(`+ ${b[j++]}`)
  return out.join('\n')
}

export interface DiffFileSource {
  entry: TreeManifestEntry
  /** Lusta tartalom-betöltő; csak szöveges, változott fájlokra hívjuk. */
  loadContent: () => Promise<string>
}

/**
 * Két fa diffje a manifestek alapján. A tartalmat csak akkor tölti be, ha
 * szöveges fájl ténylegesen módosult (a `binary_changed` esethez nem kell).
 */
export async function diffTrees(
  from: Map<string, DiffFileSource>,
  to: Map<string, DiffFileSource>,
): Promise<ChangedFile[]> {
  const changes: ChangedFile[] = []
  const allPaths = new Set<string>([...from.keys(), ...to.keys()])

  for (const path of [...allPaths].sort()) {
    const a = from.get(path)
    const b = to.get(path)
    if (a && !b) {
      changes.push({ path, changeType: 'deleted' })
      continue
    }
    if (!a && b) {
      if (b.entry.isBinary) changes.push({ path, changeType: 'binary_changed' })
      else changes.push({ path, changeType: 'added', textDiff: textLineDiff('', await b.loadContent()) })
      continue
    }
    if (a && b) {
      if (a.entry.contentHash === b.entry.contentHash) continue
      if (a.entry.isBinary || b.entry.isBinary) {
        changes.push({ path, changeType: 'binary_changed' })
      } else {
        changes.push({
          path,
          changeType: 'modified',
          textDiff: textLineDiff(await a.loadContent(), await b.loadContent()),
        })
      }
    }
  }

  return changes
}

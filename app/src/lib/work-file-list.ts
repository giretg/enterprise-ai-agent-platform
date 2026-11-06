/** A munkafájl-lista rendezése, szűrése és mappák szerinti csoportosítása (tiszta függvények). */

export type WorkFileSortKey =
  | 'path'
  | 'name'
  | 'updated_desc'
  | 'updated_asc'
  | 'created_desc'
  | 'created_asc'
  | 'size_desc'

export const WORK_FILE_SORT_KEYS: readonly WorkFileSortKey[] = [
  'path',
  'name',
  'updated_desc',
  'updated_asc',
  'created_desc',
  'created_asc',
  'size_desc',
]

export type SortableWorkFile = { path: string; byteSize: number; createdAt: string; updatedAt: string }

const collator = new Intl.Collator('hu', { numeric: true, sensitivity: 'base' })

export function fileBaseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** Mappa az útvonalból; gyökérszintű fájlnál üres szöveg. */
export function fileFolder(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).join('/')
}

function time(iso: string): number {
  const value = Date.parse(iso)
  return Number.isNaN(value) ? 0 : value
}

export function sortWorkFiles<T extends SortableWorkFile>(files: readonly T[], key: WorkFileSortKey): T[] {
  const byPath = (a: T, b: T) => collator.compare(a.path, b.path)
  const copy = [...files]
  switch (key) {
    case 'path':
      return copy.sort((a, b) => {
        const folder = collator.compare(fileFolder(a.path), fileFolder(b.path))
        return folder || collator.compare(fileBaseName(a.path), fileBaseName(b.path))
      })
    case 'name':
      return copy.sort((a, b) => collator.compare(fileBaseName(a.path), fileBaseName(b.path)) || byPath(a, b))
    case 'updated_desc':
      return copy.sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || byPath(a, b))
    case 'updated_asc':
      return copy.sort((a, b) => time(a.updatedAt) - time(b.updatedAt) || byPath(a, b))
    case 'created_desc':
      return copy.sort((a, b) => time(b.createdAt) - time(a.createdAt) || byPath(a, b))
    case 'created_asc':
      return copy.sort((a, b) => time(a.createdAt) - time(b.createdAt) || byPath(a, b))
    case 'size_desc':
      return copy.sort((a, b) => b.byteSize - a.byteSize || byPath(a, b))
  }
}

/** Ékezet- és kisbetű-érzéketlen szűrés az útvonalra; üres keresés mindent visszaad. */
export function filterWorkFiles<T extends { path: string }>(files: readonly T[], query: string): T[] {
  const needle = fold(query.trim())
  if (!needle) return [...files]
  const words = needle.split(/\s+/)
  return files.filter((file) => {
    const hay = fold(file.path)
    return words.every((word) => hay.includes(word))
  })
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Egymás utáni, azonos mappájú fájlok csoportjai (a bemenetnek már mappa szerint rendezettnek kell lennie). */
export function groupByFolder<T extends { path: string }>(files: readonly T[]): Array<{ folder: string; files: T[] }> {
  const groups: Array<{ folder: string; files: T[] }> = []
  for (const file of files) {
    const folder = fileFolder(file.path)
    const last = groups[groups.length - 1]
    if (last && last.folder === folder) last.files.push(file)
    else groups.push({ folder, files: [file] })
  }
  return groups
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown|mdown)$/i.test(path)
}

export function fileExtension(path: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(fileBaseName(path))
  return match ? `.${match[1].toLowerCase()}` : ''
}

/**
 * Az elejére tett YAML-fejléc (`---` ... `---`) nem része a szövegnek: külön
 * kapjuk, hogy a formázott nézetben ne váljon vízszintes vonallá és címmé.
 */
export function splitFrontmatter(source: string): { front: string | null; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
  if (!match) return { front: null, body: source }
  return { front: match[1], body: source.slice(match[0].length) }
}

import type { ProjectMemoryKind } from '@prisma/client'

export type MemoryIndexEntry = {
  id: string
  kind: ProjectMemoryKind
  title: string
  createdAt: string
}

/** Max JSON size of one index page in MCP responses (get_definition, project_memory.read). */
export const MEMORY_INDEX_PAGE_MAX_CHARS = 32_000

const INDEX_TITLE_MAX = 120

export function memoryDisplayTitle(title: string, body: string): string {
  const trimmed = title.trim()
  if (trimmed) {
    return trimmed.length > INDEX_TITLE_MAX ? `${trimmed.slice(0, INDEX_TITLE_MAX - 1)}…` : trimmed
  }
  const line = body.trim().split(/\r?\n/).find((row) => row.trim().length > 0)?.trim() ?? ''
  const derived = line.slice(0, INDEX_TITLE_MAX)
  return derived || 'Untitled'
}

export function toMemoryIndexEntry(row: {
  id: string
  kind: ProjectMemoryKind
  title: string
  body: string
  createdAt: string
}): MemoryIndexEntry {
  return {
    id: row.id,
    kind: row.kind,
    title: memoryDisplayTitle(row.title, row.body),
    createdAt: row.createdAt,
  }
}

export type MemoryIndexPage = {
  entries: MemoryIndexEntry[]
  totalCount: number
  offset: number
  nextOffset: number | null
}

export function paginateMemoryIndex(entries: readonly MemoryIndexEntry[], offset: number): MemoryIndexPage {
  const totalCount = entries.length
  const safeOffset = Math.min(Math.max(0, offset), totalCount)
  const page: MemoryIndexEntry[] = []
  let chars = 2
  for (let i = safeOffset; i < entries.length; i++) {
    const entry = entries[i]
    const add = JSON.stringify(entry).length + (page.length > 0 ? 1 : 0)
    if (page.length > 0 && chars + add > MEMORY_INDEX_PAGE_MAX_CHARS) break
    page.push(entry)
    chars += add
  }
  const nextOffset = safeOffset + page.length < totalCount ? safeOffset + page.length : null
  return { entries: page, totalCount, offset: safeOffset, nextOffset }
}

export function memoryMatchesQuery(row: { title: string; body: string }, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = `${row.title}\n${row.body}`.toLowerCase()
  return hay.includes(q)
}

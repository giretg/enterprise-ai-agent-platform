import type { KbHit, KbHitSource } from './kb-format'
import type { OkfSourceRef } from './kb-v3'
import type {
  KnowledgeChunkSearchHit,
  KnowledgeIndexEntry,
  KnowledgePageChunk,
} from '@/repositories/interfaces'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function snippet(value: string): string {
  return value.length > 2000 ? `${value.slice(0, 1997)}...` : value
}

export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
}

const STEM_LENGTH = 4

function stemToken(token: string): string {
  return token.length <= STEM_LENGTH ? token : token.slice(0, STEM_LENGTH)
}

function queryTermStems(query: string): string[] {
  return [
    ...new Set(
      normalizeText(query)
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3)
        .map(stemToken),
    ),
  ]
}

function stemsFromText(text: string): string[] {
  return [
    ...new Set(
      normalizeText(text)
        .split(/\s+/)
        .filter(Boolean)
        .filter((term) => term.length >= 3)
        .map(stemToken),
    ),
  ]
}

function filenameSearchText(filename: string): string {
  return filename.replace(/[._-]+/g, ' ')
}

function documentSearchCorpus(filename: string, extractedText: string | null): string {
  const header = filenameSearchText(filename)
  const body = extractedText?.trim() ?? ''
  return body ? `${header}\n\n${body}` : header
}

function toKbSource(sourceRef: unknown, section: string | null): KbHitSource {
  const ref = (isRecord(sourceRef) ? sourceRef : {}) as OkfSourceRef
  return {
    documentId: typeof ref.documentId === 'string' ? ref.documentId : undefined,
    filename: typeof ref.filename === 'string' ? ref.filename : undefined,
    page: typeof ref.page === 'number' ? ref.page : undefined,
    section: section ?? (typeof ref.section === 'string' ? ref.section : undefined),
    cell: typeof ref.cell === 'string' ? ref.cell : undefined,
  }
}

function pathDepth(path: string): number {
  return path.split('/').filter(Boolean).length
}

export type KbSearchHit = KbHit

export function assembleKbHits(input: {
  query: string
  k: number
  memoryContent: string
  memoryId: string | null
  memoryVersion: number | null
  okfChunkHits: KnowledgeChunkSearchHit[]
  docs: Array<{ id: string; filename: string; extractedText: string | null }>
  supersededDocIds: Set<string>
}): KbSearchHit[] {
  const { query, k } = input
  const termStems = queryTermStems(query)
  const FILENAME_STEM_WEIGHT = 3

  type ScoredChunk = {
    chunk: string
    score: number
    docId: string
    sourceRef: string
    memoryVersion: number | null
  }

  function scoreChunks(
    text: string,
    docId: string,
    sourceRef: string,
    memoryVersion: number | null,
    filenameStems: Iterable<string> = [],
  ): ScoredChunk[] {
    const filenameStemSet = new Set(filenameStems)
    return text
      .split(/\n{2,}|\n(?=-\s+)/)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const chunkStems = new Set(
          normalizeText(chunk).split(/\s+/).filter(Boolean).map(stemToken),
        )
        const score = termStems.reduce((sum, stem) => {
          if (filenameStemSet.has(stem)) return sum + FILENAME_STEM_WEIGHT
          if (chunkStems.has(stem)) return sum + 1
          return sum
        }, 0)
        return { chunk, score, docId, sourceRef, memoryVersion }
      })
      .filter((item) => item.score > 0)
  }

  const okfHits: KbSearchHit[] = input.okfChunkHits.map((hit) => {
    const ref = (isRecord(hit.sourceRef) ? hit.sourceRef : {}) as OkfSourceRef
    const source = {
      documentId: typeof ref.documentId === 'string' ? ref.documentId : undefined,
      filename: typeof ref.filename === 'string' ? ref.filename : undefined,
      page: typeof ref.page === 'number' ? ref.page : undefined,
      section: hit.section ?? (typeof ref.section === 'string' ? ref.section : undefined),
      cell: typeof ref.cell === 'string' ? ref.cell : undefined,
    }
    return {
      docId: source.documentId ? `doc:${source.documentId}` : `okf:${hit.artifactId}`,
      snippet: snippet(hit.text),
      sourceRef: `okf:${hit.path}:${source.filename ?? hit.title}`,
      memoryVersion: null,
      path: hit.path,
      title: hit.title,
      score: hit.score,
      source,
    }
  })

  const memoryChunks = scoreChunks(
    input.memoryContent,
    `memory:${input.memoryId}`,
    `memory:${input.memoryId}:v${input.memoryVersion ?? 'unknown'}`,
    input.memoryVersion,
  )

  const flatDocs = input.docs.filter((doc) => !input.supersededDocIds.has(doc.id))
  const docChunks: ScoredChunk[] = flatDocs.flatMap((doc) =>
    scoreChunks(
      documentSearchCorpus(doc.filename, doc.extractedText),
      `doc:${doc.id}`,
      `doc:${doc.id}:${doc.filename}`,
      null,
      stemsFromText(filenameSearchText(doc.filename)),
    ),
  )

  const legacyHits: KbSearchHit[] = [...memoryChunks, ...docChunks]
    .sort((a, b) => b.score - a.score)
    .map((item) => ({
      docId: item.docId,
      snippet: snippet(item.chunk),
      sourceRef: item.sourceRef,
      memoryVersion: item.memoryVersion,
    }))

  const hits: KbSearchHit[] = [...okfHits, ...legacyHits].slice(0, k)
  if (hits.length > 0) return hits
  if (flatDocs.length === 0) return hits

  return flatDocs
    .map((doc) => {
      const corpus = normalizeText(documentSearchCorpus(doc.filename, doc.extractedText))
      const filenameScore = stemsFromText(filenameSearchText(doc.filename)).filter((stem) =>
        termStems.includes(stem),
      ).length
      const contentScore = termStems.filter((stem) => corpus.includes(stem)).length
      return { doc, score: Math.max(filenameScore, contentScore) }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ doc }) => ({
      docId: `doc:${doc.id}`,
      snippet: snippet(documentSearchCorpus(doc.filename, doc.extractedText)),
      sourceRef: `doc:${doc.id}:${doc.filename}`,
      memoryVersion: null,
    }))
}

export type KbListIndexResult = {
  pages: Array<{ path: string; title: string; type: string; artifactId: string }>
}

export function assembleKbIndex(entries: KnowledgeIndexEntry[], maxDepth?: number): KbListIndexResult {
  const pages = entries
    .filter((entry) => maxDepth === undefined || pathDepth(entry.path) <= maxDepth)
    .map((entry) => ({
      path: entry.path,
      title: entry.title,
      type: entry.type,
      artifactId: entry.artifactId,
    }))
  return { pages }
}

export type KbGetPageResult =
  | { found: false; path: string }
  | {
      found: true
      path: string
      title: string
      type: string
      artifactId: string
      text: string
      source: KbHitSource
    }

export function assembleKbPage(path: string, chunks: KnowledgePageChunk[]): KbGetPageResult {
  if (chunks.length === 0) return { found: false, path }
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)
  const first = ordered[0]
  return {
    found: true,
    path,
    title: first.title,
    type: first.type,
    artifactId: first.artifactId,
    text: ordered
      .map((chunk) => chunk.text.trim())
      .filter(Boolean)
      .join('\n\n'),
    source: toKbSource(first.sourceRef, first.section),
  }
}

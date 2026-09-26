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

/**
 * Közös rangsor a wiki-oldal és a raw fájl-szakasz jelöltekre: a találatban
 * szereplő kérdésszavak IDF-súlyának összege (a jelölt-halmazon mért ritkaság),
 * holtversenyben ts_rank. Így a ritka, tartalmi szó („TCO") többet ér, mint a
 * mindenhol előforduló („oldal"), és a hosszú fájl nem nyer a hossza miatt.
 */
export function rankKbHits(
  candidates: Array<{ hit: KbHit; matched: string[]; rank: number }>,
  k: number,
): KbHit[] {
  const df = new Map<string, number>()
  for (const c of candidates) {
    for (const term of new Set(c.matched)) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const n = candidates.length
  return candidates
    .map((c) => ({
      hit: c.hit,
      score:
        [...new Set(c.matched)].reduce((sum, term) => sum + Math.log(1 + n / df.get(term)!), 0) +
        Math.min(c.rank, 0.99) / 10,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ hit, score }) => ({ ...hit, score: Math.round(score * 1000) / 1000 }))
}

const PURPOSE_MAX = 240

export function normalizeKbPurpose(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return null
  return trimmed.slice(0, PURPOSE_MAX)
}

export function readKbPurpose(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null
  return normalizeKbPurpose(typeof metadata.purpose === 'string' ? metadata.purpose : null)
}

export type KbCatalogPage = { path: string; title: string }

export type KbCatalogSource = {
  documentId: string
  filename: string
  kind: 'file' | 'wiki'
  purpose: string | null
  chars: number
  artifactId?: string
  pageCount?: number
  pages?: KbCatalogPage[]
}

export type KbCatalogResult = { sources: KbCatalogSource[] }

export function assembleKbCatalog(input: {
  docs: Array<{
    id: string
    filename: string
    processingMode: string | null
    metadata: unknown
    chars: number
  }>
  artifacts: Array<{ id: string; sourceDocumentId: string | null; status: string }>
  entries: KnowledgeIndexEntry[]
}): KbCatalogResult {
  const artifactByDoc = new Map<string, string>()
  for (const artifact of input.artifacts) {
    if (artifact.status !== 'published' || !artifact.sourceDocumentId) continue
    artifactByDoc.set(artifact.sourceDocumentId, artifact.id)
  }
  const pagesByArtifact = new Map<string, KbCatalogPage[]>()
  for (const entry of input.entries) {
    if (entry.path === 'index.md') continue
    const pages = pagesByArtifact.get(entry.artifactId) ?? []
    pages.push({ path: entry.path, title: entry.title })
    pagesByArtifact.set(entry.artifactId, pages)
  }
  const sources = input.docs
    .map((doc): KbCatalogSource => {
      const purpose = readKbPurpose(doc.metadata)
      const artifactId = artifactByDoc.get(doc.id)
      if (artifactId && doc.processingMode === 'okf') {
        const pages = (pagesByArtifact.get(artifactId) ?? []).sort((a, b) => a.path.localeCompare(b.path))
        return {
          documentId: doc.id,
          filename: doc.filename,
          kind: 'wiki',
          purpose,
          chars: doc.chars,
          artifactId,
          pageCount: pages.length,
          pages,
        }
      }
      return {
        documentId: doc.id,
        filename: doc.filename,
        kind: 'file',
        purpose,
        chars: doc.chars,
      }
    })
    .sort((a, b) => a.filename.localeCompare(b.filename))
  return { sources }
}

function unquoteYaml(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      return typeof parsed === 'string' ? parsed : trimmed
    } catch {
      return trimmed.replace(/^"|"$/g, '')
    }
  }
  return trimmed
}

/** Az OKF bundle `index.md` törzse. A chunkok közé szándékosan nem kerül. */
export function okfIndexFile(bundle: unknown): { title: string; text: string } | null {
  if (!isRecord(bundle) || !Array.isArray(bundle.files)) return null
  const file = bundle.files.find(
    (entry) => isRecord(entry) && entry.path === 'index.md' && typeof entry.content === 'string',
  )
  if (!file || !isRecord(file) || typeof file.content !== 'string') return null
  const content = file.content
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  const titleLine = (fm?.[1] ?? content).match(/^title:\s*(.+)$/m)
  const title = titleLine ? unquoteYaml(titleLine[1]) : 'index.md'
  const text = (fm ? fm[2] : content).trim()
  if (!text) return null
  return { title, text }
}

export const KB_DOCUMENT_INLINE_CHARS = 8_000

type OutlineSection = { title: string; body: string }

/** Fix méretű lapozás, ha a nyers fájlnak nincs `#`/`##`/`###` headingje. */
function windowSections(text: string): OutlineSection[] {
  const windows: OutlineSection[] = []
  for (let start = 0; start < text.length; start += KB_DOCUMENT_INLINE_CHARS) {
    const end = Math.min(start + KB_DOCUMENT_INLINE_CHARS, text.length)
    windows.push({
      title: `Part ${windows.length + 1} (chars ${start + 1}-${end})`,
      body: text.slice(start, end),
    })
  }
  return windows
}

/**
 * A raw szöveg szeletei `#`/`##`/`###` heading-sorok mentén. A `searchRaw` SQL-je
 * (`KB_SECTION_SPLIT_SQL`) UGYANEZT a vágást végzi, így a találat sorszáma
 * (`ord`, 1-től) ebbe a tömbbe indexel.
 */
export function splitKbSegments(text: string): string[] {
  return text.split(/\n(?=#{1,3}[ \t])/)
}

/** Postgres ARE megfelelője a `splitKbSegments` regexének. */
export const KB_SECTION_SPLIT_SQL = '\\n(?=#{1,3}[ \\t])'

export const KB_SECTION_PATH_SEPARATOR = ' › '

type KbSection = OutlineSection & { segment: number }

/**
 * Heading-szakaszok egyedi, útvonal-szerű címmel (`Szülő › Gyerek`); a törzs a
 * teljes részfa (al-headingekkel együtt). Egyetlen, legfelső `#` cím nem kerül
 * minden útvonal elejére. Heading nélküli szövegnél fix ablakok.
 */
function outlineSections(text: string): KbSection[] {
  const segments = splitKbSegments(text)
  const headed: Array<{ segment: number; level: number; title: string }> = []
  segments.forEach((seg, segment) => {
    const heading = seg.replace(/^\n+/, '').split('\n', 1)[0].match(/^(#{1,3})[ \t]+(.*)$/)
    if (heading) headed.push({ segment, level: heading[1].length, title: heading[2].trim() })
  })
  if (headed.length === 0) {
    return text.trim() ? windowSections(text).map((w) => ({ ...w, segment: -1 })) : []
  }
  const soleRoot = headed.filter((h) => h.level === 1).length === 1 && headed[0].level === 1
  const stack: Array<{ level: number; title: string }> = []
  const seen = new Map<string, number>()
  return headed.map((h, i) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop()
    const ancestors = stack.filter((a, idx) => !(soleRoot && idx === 0 && a.level === 1))
    stack.push({ level: h.level, title: h.title })
    let path = [...ancestors.map((a) => a.title), h.title].join(KB_SECTION_PATH_SEPARATOR)
    const count = (seen.get(path) ?? 0) + 1
    seen.set(path, count)
    if (count > 1) path = `${path} (${count})`
    // A részfa a következő azonos/magasabb szintű headingig tart.
    const next = headed.slice(i + 1).find((later) => later.level <= h.level)
    const end = next ? next.segment : segments.length
    const own = segments[h.segment].replace(/^\n*[^\n]*\n?/, '')
    const body = [own, ...segments.slice(h.segment + 1, end)].join('\n').trim()
    return { title: path, body, segment: h.segment }
  })
}

/** A `splitKbSegments` szerinti szelet szakasz-útvonala (keresési találathoz). */
export function kbSectionForSegment(text: string, segment: number): string | undefined {
  return outlineSections(text).find((section) => section.segment === segment)?.title
}

function normalizeSectionNeedle(value: string): string {
  return value.trim().toLowerCase().replace(/\s*(›|>)\s*/g, KB_SECTION_PATH_SEPARATOR)
}

/** Pontos útvonal → egyedi pontos utolsó cím → egyedi részleges egyezés. */
function findSection(
  sections: KbSection[],
  query: string,
): { hit: KbSection } | { matches: string[] } {
  const needle = normalizeSectionNeedle(query)
  const exact = sections.find((s) => s.title.toLowerCase() === needle)
  if (exact) return { hit: exact }
  const leaf = (s: KbSection) => s.title.split(KB_SECTION_PATH_SEPARATOR).pop()!.toLowerCase()
  const byLeaf = sections.filter((s) => leaf(s) === needle)
  if (byLeaf.length === 1) return { hit: byLeaf[0] }
  if (byLeaf.length > 1) return { matches: byLeaf.map((s) => s.title) }
  const partial = sections.filter((s) => s.title.toLowerCase().includes(needle))
  if (partial.length === 1) return { hit: partial[0] }
  return { matches: partial.map((s) => s.title) }
}

export type KbDocumentResult =
  | { found: false; documentId: string }
  | {
      found: true
      kind: 'wiki'
      documentId: string
      filename: string
      purpose: string | null
      artifactId: string | null
      hint: string
    }
  | {
      found: true
      kind: 'file'
      documentId: string
      filename: string
      purpose: string | null
      chars: number
      truncated: boolean
      outline?: string[]
      text?: string
      section?: string
      sectionFound?: boolean
      /** Több szakaszra illő `section`: ezek közül kell pontosan egyet kérni. */
      matches?: string[]
    }

export function assembleKbDocument(input: {
  documentId: string
  filename: string
  purpose: string | null
  text: string
  section?: string
}): Exclude<KbDocumentResult, { found: false } | { kind: 'wiki' }> {
  const sections = outlineSections(input.text)
  const outline = sections.map((section) => section.title)
  const base = {
    found: true as const,
    kind: 'file' as const,
    documentId: input.documentId,
    filename: input.filename,
    purpose: input.purpose,
    chars: input.text.length,
  }
  const section = input.section?.trim()
  if (section) {
    const found = findSection(sections, section)
    if (!('hit' in found)) {
      return {
        ...base,
        truncated: true,
        section,
        sectionFound: false,
        // Többértelmű név: csak a jelöltek, nem a teljes vázlat.
        ...(found.matches.length > 0 ? { matches: found.matches } : { outline }),
      }
    }
    const hit = found.hit
    const truncated = hit.body.length > KB_DOCUMENT_INLINE_CHARS
    return {
      ...base,
      truncated,
      section,
      sectionFound: true,
      text: truncated ? hit.body.slice(0, KB_DOCUMENT_INLINE_CHARS) : hit.body,
    }
  }
  if (input.text.length <= KB_DOCUMENT_INLINE_CHARS) {
    return { ...base, truncated: false, text: input.text }
  }
  return { ...base, truncated: true, outline }
}

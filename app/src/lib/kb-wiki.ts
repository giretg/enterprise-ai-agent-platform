import { renderWikiTemplate, type WikiTemplateId } from './wiki-templates'
import { resolveKbLanguage } from './kb-language'
/**
 * #943 LLM Wiki 2/6 — a wiki-oldalak determinisztikus, DB-mentes része (#941 §1, D8, D9).
 *
 * - path-szabály és védett path-ok,
 * - `[[path]]` / relatív markdown-link normalizálás,
 * - fejezet-szintű `patch` (`appendToSection` / `replaceSection`),
 * - `index.md` és `log.md` generálás az oldalak `summary`/`category` mezőiből és a naplóból,
 * - alap `WIKI.md` séma.
 *
 * Szerveroldali AI nincs (D3): minden itt tiszta függvény.
 */
import { createHash } from 'node:crypto'

export const WIKI_MAX_PAGES_PER_WRITE = 50
export const WIKI_MAX_PAGE_CHARS = 20_000
export const WIKI_PATH_RE = /^[a-z0-9-/]+\.md$/
/** A szerver generálja (index, log) vagy ember szerkeszti (WIKI.md, D15) — agent nem írhatja. */
export const WIKI_RESERVED_PATHS = new Set(['index.md', 'log.md', 'wiki.md'])
export const WIKI_SCHEMA_PATH = 'WIKI.md'
export const WIKI_INDEX_PATH = 'index.md'
export const WIKI_LOG_PATH = 'log.md'

export const WIKI_PAGE_TYPES = ['source', 'entity', 'concept', 'analysis', 'overview'] as const
export type WikiPageTypeName = (typeof WIKI_PAGE_TYPES)[number]

/** A frontmatter mezői, amelyeket külön oszlop hordoz — a `frontmatter` JSON-ból kimaradnak. */
const MANAGED_FRONTMATTER_KEYS = new Set(['type', 'title', 'summary', 'category', 'sources'])

export type WikiSourceRef = {
  documentId: string
  filename?: string
  page?: number
  section?: string
  cell?: string
}

/** Egy oldal teljes, írás utáni állapota (a `WikiPage` oszlopai). */
export type WikiPageState = {
  path: string
  type: WikiPageTypeName
  title: string
  summary: string
  category: string | null
  /** A kezelt kulcsok (type/title/summary/category/sources) nélkül. */
  frontmatter: Record<string, unknown>
  body: string
  sources: WikiSourceRef[]
}

export function isValidWikiPath(path: string): boolean {
  if (!WIKI_PATH_RE.test(path)) return false
  if (path.startsWith('/') || path.includes('//')) return false
  return path.split('/').every((part) => part.length > 0 && part !== '-' && !part.startsWith('.'))
}

export function isReservedWikiPath(path: string): boolean {
  return WIKI_RESERVED_PATHS.has(path.toLowerCase())
}

/** `baseVersion` = a tartalom hash-e: ami változik, az eltér (cím, összefoglaló, törzs, források is). */
export function wikiPageContentHash(state: Omit<WikiPageState, 'path'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        state.type,
        state.title,
        state.summary,
        state.category,
        sortKeys(state.frontmatter),
        state.sources,
        state.body,
      ]),
    )
    .digest('hex')
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    )
  }
  return value
}

export function stripManagedFrontmatter(frontmatter: unknown): Record<string, unknown> {
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) return {}
  return Object.fromEntries(
    Object.entries(frontmatter as Record<string, unknown>).filter(([key]) => !MANAGED_FRONTMATTER_KEYS.has(key)),
  )
}

/** `frontmatter.sources` → normalizált forráslista (documentId szerint egyedi, sorrendtartó). */
export function readWikiSources(value: unknown): WikiSourceRef[] {
  if (!Array.isArray(value)) return []
  const out: WikiSourceRef[] = []
  for (const item of value) {
    const raw = typeof item === 'string' ? { documentId: item } : item
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    if (typeof row.documentId !== 'string' || !row.documentId.trim()) continue
    out.push({
      documentId: row.documentId.trim(),
      ...(typeof row.filename === 'string' && row.filename ? { filename: row.filename } : {}),
      ...(typeof row.page === 'number' ? { page: row.page } : {}),
      ...(typeof row.section === 'string' && row.section ? { section: row.section } : {}),
      ...(typeof row.cell === 'string' && row.cell ? { cell: row.cell } : {}),
    })
  }
  return mergeWikiSources([], out)
}

export function mergeWikiSources(base: WikiSourceRef[], extra: WikiSourceRef[]): WikiSourceRef[] {
  const seen = new Set<string>()
  const out: WikiSourceRef[] = []
  for (const ref of [...base, ...extra]) {
    const key = JSON.stringify([ref.documentId, ref.page ?? null, ref.section ?? null, ref.cell ?? null])
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

/** Ha az agent a törzsbe is frontmattert tett, levágjuk (a mezők külön érkeznek). */
export function stripLeadingFrontmatter(body: string): { body: string; stripped: boolean } {
  const match = body.match(/^---\n[\s\S]*?\n---\n?/)
  if (!match) return { body, stripped: false }
  return { body: body.slice(match[0].length), stripped: true }
}

// ---------------------------------------------------------------------------
// Linkek

function resolveRelative(fromPath: string, target: string): string {
  const baseDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const parts = (target.startsWith('/') ? [] : baseDir ? baseDir.split('/') : []).concat(target.split('/'))
  const stack: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

/**
 * Az oldal kimenő wiki-linkjei normalizált path-ként (`entities/teya.md`).
 * `[[path]]`, `[[path|címke]]` és relatív `.md` markdown-link; külső URL nem.
 */
export function extractWikiLinks(body: string, fromPath: string): string[] {
  const out = new Set<string>()
  for (const match of body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const target = match[1].trim().replace(/^\/+/, '')
    if (!target) continue
    out.add(target.endsWith('.md') ? target : `${target}.md`)
  }
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1].split('#')[0].split('?')[0]
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || !target.endsWith('.md')) continue
    out.add(resolveRelative(fromPath, target))
  }
  return [...out].sort()
}

// ---------------------------------------------------------------------------
// Fejezet-patch (D-patch: a teljes oldal beolvasása nélkül)

type SectionRange = { start: number; bodyStart: number; end: number; level: number }

function normalizeHeading(value: string): string {
  return value.replace(/^#+\s*/, '').trim().toLowerCase()
}

function findSection(body: string, section: string): SectionRange | null {
  const wanted = normalizeHeading(section)
  const lines = body.split('\n')
  let offset = 0
  let found: SectionRange | null = null
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})[ \t]+(.*)$/)
    if (heading) {
      const level = heading[1].length
      if (found && level <= found.level) {
        found.end = offset
        return found
      }
      if (!found && normalizeHeading(heading[2]) === wanted) {
        found = { start: offset, bodyStart: offset + line.length + 1, end: body.length, level }
      }
    }
    offset += line.length + 1
  }
  if (found) {
    found.bodyStart = Math.min(found.bodyStart, body.length)
    found.end = body.length
  }
  return found
}

/** A fejezet jelenlegi tartalma (ütközésvizsgálathoz); `null`, ha nincs ilyen fejezet. */
export function sectionContent(body: string, section: string): string | null {
  const range = findSection(body, section)
  return range ? body.slice(range.bodyStart, range.end).trim() : null
}

function splitAtSection(body: string, range: SectionRange) {
  const rawHead = body.slice(0, range.bodyStart)
  return {
    head: rawHead.endsWith('\n') ? rawHead : `${rawHead}\n`,
    own: body.slice(range.bodyStart, range.end).replace(/\s+$/, ''),
    tail: body.slice(range.end),
  }
}

function joinSection(head: string, own: string, tail: string): string {
  return tail ? `${head}${own}\n\n${tail}` : `${head}${own}\n`
}

const LIST_OR_TABLE_LINE = /^\s*([|*-]|\d+\.)/

/** Sor / bekezdés a fejezet végére; hiányzó fejezet a törzs végére kerül `##` címmel. */
export function appendToSection(body: string, section: string, text: string): string {
  const addition = text.replace(/\s+$/, '')
  const range = findSection(body, section)
  if (!range) {
    const title = section.replace(/^#+\s*/, '').trim()
    return `${body.replace(/\s+$/, '')}\n\n## ${title}\n\n${addition}\n`
  }
  const { head, own, tail } = splitAtSection(body, range)
  if (!own.trim()) return joinSection(head, `\n${addition}`, tail)
  // Táblázat / lista folytatása üres sor nélkül, bekezdés üres sorral.
  const lastLine = own.split('\n').pop() ?? ''
  const joiner = LIST_OR_TABLE_LINE.test(lastLine) && LIST_OR_TABLE_LINE.test(addition) ? '\n' : '\n\n'
  return joinSection(head, `${own}${joiner}${addition}`, tail)
}

/** A fejezet törzsének cseréje (a címsor marad); hiányzó fejezet → `null`. */
export function replaceSection(body: string, section: string, text: string): string | null {
  const range = findSection(body, section)
  if (!range) return null
  const { head, tail } = splitAtSection(body, range)
  return joinSection(head, `\n${text.trim()}`, tail)
}

// ---------------------------------------------------------------------------
// index.md / log.md / WIKI.md (D8)

export type WikiIndexPage = {
  path: string
  title: string
  summary: string
  category: string | null
  type: string
}

export const WIKI_UNCATEGORIZED = 'Uncategorized'

/** Kategóriánként csoportosítva, path szerint rendezve — azonos bemenetre azonos kimenet. */
export function groupWikiIndex(pages: WikiIndexPage[]): Array<{ category: string; pages: WikiIndexPage[] }> {
  const groups = new Map<string, WikiIndexPage[]>()
  for (const page of pages) {
    const category = page.category?.trim() || WIKI_UNCATEGORIZED
    groups.set(category, [...(groups.get(category) ?? []), page])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === WIKI_UNCATEGORIZED ? 1 : b === WIKI_UNCATEGORIZED ? -1 : a.localeCompare(b)))
    .map(([category, rows]) => ({ category, pages: rows.sort((a, b) => a.path.localeCompare(b.path)) }))
}

export function renderWikiIndex(pages: WikiIndexPage[]): string {
  const lines = ['# Index', '', `${pages.length} page${pages.length === 1 ? '' : 's'}.`]
  for (const group of groupWikiIndex(pages)) {
    lines.push('', `## ${group.category}`, '')
    for (const page of group.pages) {
      lines.push(`- [[${page.path.replace(/\.md$/, '')}]] — ${page.title}: ${page.summary}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export type WikiLogRow = {
  op: string
  title: string
  note: string | null
  pagePaths: string[]
  createdAt: Date
}

/** Karpathy-formátum: `## [YYYY-MM-DD] op | cím` — időrendben, append-only. */
export function renderWikiLog(entries: WikiLogRow[]): string {
  const lines = ['# Log']
  for (const entry of entries) {
    lines.push('', `## [${entry.createdAt.toISOString().slice(0, 10)}] ${entry.op} | ${entry.title}`)
    if (entry.note) lines.push('', entry.note)
    if (entry.pagePaths.length) {
      lines.push('', `Pages: ${entry.pagePaths.map((path) => `[[${path.replace(/\.md$/, '')}]]`).join(', ')}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** Az oldal markdownként (olvasáshoz / exporthoz), OKF-kompatibilis frontmatterrel. */
export function renderWikiPageMarkdown(state: Omit<WikiPageState, 'path'>): string {
  const fm: Record<string, unknown> = {
    type: state.type,
    title: state.title,
    summary: state.summary,
    ...(state.category ? { category: state.category } : {}),
    ...state.frontmatter,
    ...(state.sources.length ? { sources: state.sources } : {}),
  }
  const lines = Object.entries(fm).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  return `---\n${lines.join('\n')}\n---\n\n${state.body.replace(/^\n+/, '')}`
}

/** Új wiki alap-sémája (§2). Ember szerkeszti a Control Plane-en (D15). */
export function defaultWikiSchema(kbLanguage: string, template: WikiTemplateId = 'general'): string {
  return renderWikiTemplate(template, resolveKbLanguage(kbLanguage))
}

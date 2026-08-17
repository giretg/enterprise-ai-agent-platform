/**
 * WP-8 — Tool Broker megosztott, állapotmentes segédfüggvények (a broker-magból
 * kiemelve). Repo-import (GitHub tree/blob) helperek, KB-v3 retrieval-összeállítók
 * (assembleKbHits/Index/Page), audit-meta építők (argsMeta/resultMeta), szöveg-
 * normalizálás/stemming és a user-directory szűrő. Tisztán függvények — nincs
 * broker-`this` függés; a mag és a handlerek egyaránt innen importálnak.
 */
import { createHash } from 'node:crypto'
import type { Agent } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { OkfSourceRef } from '@/lib/kb-v3'
import type {
  KnowledgeChunkSearchHit,
  KnowledgeIndexEntry,
  KnowledgePageChunk,
} from '@/repositories/interfaces'
import type {
  WebSearchEffectiveQuery,
  WebSearchResult,
} from '@/domain/web-search/web-search-types'
import type {
  AgentAskResult,
  KbGetPageResult,
  KbListIndexResult,
  KbSearchHit,
  KbSource,
  RepoPrepareArgs,
  ToolBrokerInvokeInput,
  ToolExecutionResult,
  UserDirectoryArgs,
  UserDirectoryEntry,
  UserDirectoryResult,
  UserDirectorySearchEntry,
  WebResearchDelegationResult,
} from './tool-broker-types'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * user_directory tiszta, fail-closed szűrője (DB-mentes, determinisztikusan
 * tesztelhető). Érdemi query nélkül nem ad vissza névsort. A keresés belsőleg az
 * e-mailt is használhatja, de a tool-válasz csak a feladatkiosztáshoz szükséges
 * mezőket tartalmazza — az e-mail soha nem kerül modellkontextusba.
 *
 * A fail-closed kapu a NORMALIZÁLT query-n áll: a `normalizeText` az írásjeleket
 * szóközre cseréli, ezért a csupa írásjel query (pl. "@" vagy "...") üres
 * keresésnek számít — különben üres szótagra illesztene, és pont a teljes
 * névsort adná vissza.
 *
 * Az e-mail CSAK teljes címre illeszkedik (nem részstringre): a domain-részletre
 * illesztés a tenant teljes névsorát visszaadná, ami ugyanaz a tömeges lekérés,
 * amit ez a szűrő megakadályoz. Név / szerep / leírás továbbra is részstringre
 * illeszkedik (ÉS-kapcsolt szótagokkal).
 */
export function filterUserDirectory(
  entries: UserDirectorySearchEntry[],
  args: UserDirectoryArgs,
): UserDirectoryResult {
  const query = collapseSpaces(normalizeText(args.query ?? ''))
  const terms = query.split(' ').filter(Boolean)
  if (terms.length === 0) return { users: [] }

  const filtered = entries.filter((u) => {
    const haystack = normalizeText([u.name, u.jobDescription ?? '', u.role ?? ''].join(' '))
    // A teljes query-t hasonlítjuk a címhez, mert a normalizálás az e-mailt is
    // szótagokra bontja ("bela@ceg.hu" → "bela ceg hu").
    const email = collapseSpaces(normalizeText(u.email))
    if (query === email) return true
    return terms.every((term) => haystack.includes(term))
  })

  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100)
  const users: UserDirectoryEntry[] = filtered.slice(0, limit).map((u) => ({
    userId: u.userId,
    name: u.name,
    role: u.role,
    jobDescription: u.jobDescription,
    status: u.status,
  }))
  return { users }
}

function collapseSpaces(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
}

// Magyar ragoz\u00e1s \u00e1thidal\u00e1sa: a tokeneket egy r\u00f6vid sz\u00f3t\u0151re v\u00e1gjuk, \u00edgy a
// k\u00e9rd\u00e9sbeli ragozott alak (pl. "gatewayeken", "m\u0171veleteinek") egyezik a
// dokumentumbeli alapalakkal ("gateway", "m\u0171velet"). Nyers r\u00e9szstring helyett
// prefix-bucket egyez\u00e9st haszn\u00e1lunk, ami a recallt jav\u00edtja keyword keres\u00e9sn\u00e9l.
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

export const REPO_WORKSPACE_PATH = 'repo'
export const REPO_METADATA_PATH = `${REPO_WORKSPACE_PATH}/.repo_prepare.json`
export const REPO_IMPORT_MAX_FILES = Number(process.env.REPO_PREPARE_MAX_FILES ?? 1200)
export const REPO_IMPORT_MAX_TOTAL_BYTES = Number(process.env.REPO_PREPARE_MAX_TOTAL_BYTES ?? 12 * 1024 * 1024)
export const REPO_IMPORT_MAX_FILE_BYTES = Number(process.env.REPO_PREPARE_MAX_FILE_BYTES ?? 512 * 1024)

const REPO_EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.vercel',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.cache',
  'vendor',
])

const REPO_SKIPPED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.mov', '.mp3', '.wav', '.exe', '.dll',
])

type GitHubRepoTarget = { owner: string; repo: string; ref?: string }
export type GitHubRepoResponse = { default_branch?: string }
export type GitHubCommitResponse = { sha: string; commit?: { tree?: { sha?: string } } }
export type GitHubTreeItem = { path: string; mode: string; type: string; sha: string; size?: number }
export type GitHubTreeResponse = { tree: GitHubTreeItem[]; truncated?: boolean }
export type GitHubBlobResponse = { content: string; encoding: string; size?: number }
export type RepoPrepareMetadata = {
  owner: string
  repo: string
  ref: string
  commitSha: string
  repoPath: string
  filesIndexed: number
  bytesWritten: number
  preparedAt: string
}

function parseGitHubRepoUrl(repoUrl: string): GitHubRepoTarget | null {
  try {
    const url = new URL(repoUrl.trim())
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (url.hostname === 'github.com' && parts.length >= 2) {
      return { owner: parts[0], repo: parts[1].replace(/\.git$/i, '') }
    }
    if (url.hostname === 'api.github.com' && parts[0] === 'repos' && parts.length >= 3) {
      return { owner: parts[1], repo: parts[2].replace(/\.git$/i, '') }
    }
  } catch {
    return null
  }
  return null
}

function validGitHubName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && !value.includes('..') && !value.includes('/')
}

export function resolveRepoTarget(args: RepoPrepareArgs, agent: Agent): GitHubRepoTarget {
  const direct =
    args.owner && args.repo
      ? { owner: args.owner, repo: args.repo, ref: args.ref }
      : args.repoUrl
        ? { ...parseGitHubRepoUrl(args.repoUrl), ref: args.ref }
        : null
  if (direct?.owner && direct.repo) {
    if (!validGitHubName(direct.owner) || !validGitHubName(direct.repo)) {
      throw new Error('repo_prepare invalid GitHub owner/repo')
    }
    return { owner: direct.owner, repo: direct.repo, ref: direct.ref }
  }

  const config = isRecord(agent.modelConfig) ? agent.modelConfig : {}
  const candidates = [
    config.repoUrl,
    config.repositoryUrl,
    config.githubRepoUrl,
    isRecord(config.repository) ? config.repository.url : undefined,
    isRecord(config.repo) ? config.repo.url : undefined,
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const parsed = parseGitHubRepoUrl(candidate)
    if (parsed) {
      return {
        ...parsed,
        ref:
          args.ref ??
          (isRecord(config.repository) && typeof config.repository.ref === 'string'
            ? config.repository.ref
            : undefined),
      }
    }
  }

  const structured = isRecord(config.repository)
    ? config.repository
    : isRecord(config.repo)
      ? config.repo
      : null
  if (structured && typeof structured.owner === 'string' && typeof structured.repo === 'string') {
    if (!validGitHubName(structured.owner) || !validGitHubName(structured.repo)) {
      throw new Error('repo_prepare invalid configured GitHub owner/repo')
    }
    return {
      owner: structured.owner,
      repo: structured.repo,
      ref: args.ref ?? (typeof structured.ref === 'string' ? structured.ref : undefined),
    }
  }

  throw new Error('repo_prepare requires repoUrl or owner+repo, or an agent modelConfig.repository')
}

export function shouldSkipRepoPath(path: string, size = 0): boolean {
  const parts = path.split('/')
  if (parts.some((part) => REPO_EXCLUDED_DIRS.has(part))) return true
  if (size > REPO_IMPORT_MAX_FILE_BYTES) return true
  const lower = path.toLowerCase()
  return [...REPO_SKIPPED_EXTENSIONS].some((ext) => lower.endsWith(ext))
}

export function decodeRepoMetadata(raw: string | null): RepoPrepareMetadata | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RepoPrepareMetadata>
    if (
      typeof parsed.owner === 'string' &&
      typeof parsed.repo === 'string' &&
      typeof parsed.ref === 'string' &&
      typeof parsed.commitSha === 'string'
    ) {
      return parsed as RepoPrepareMetadata
    }
  } catch {
    return null
  }
  return null
}

export function assertUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false
  const text = buffer.toString('utf8')
  return !text.includes('\uFFFD')
}

/** Git blob SHA-1 (a GitHub tree/blob API ugyan\u00EDgy c\u00EDmzi a tartalmat), hogy a
 *  workspace-f\u00E1jlokat b\u00E1jt-egyenl\u0151s\u00E9g szerint tudjuk \u00F6sszevetni az import\u00E1lt
 *  snapshot blob-shaival \u2014 en\u00E9lk\u00FCl nem der\u00FClne ki, melyik f\u00E1jl v\u00E1ltozott. */
export function gitBlobSha1(content: Buffer): string {
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8')
  return createHash('sha1').update(Buffer.concat([header, content])).digest('hex')
}

export function repoPrepareNextSteps(): string[] {
  return [
    'Use file_search under repoPath before reading files.',
    'Use file_glob for filename/path discovery.',
    'Use file_read only for the specific files you need.',
    'Use file_edit/file_write for workspace changes, then summarize exact changed paths.',
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

export function snippet(value: string): string {
  return value.length > 2000 ? `${value.slice(0, 1997)}...` : value
}

/**
 * KB-v3 §10 retrieval-összeállítás — tiszta, DB-mentes (ezért determinisztikusan
 * tesztelhető). Sorrend:
 *  1) published OKF-chunk full-text találatok (kurált, elöl — §9.1),
 *  2) legacy stem-scoring a memórián + a NEM-superseded nyers dokumentumokon (§11.3),
 *     k-ig feltöltve az OKF-találatok után,
 *  3) ha egyik sem adott találatot: teljes-korpusz (fájlnév + törzs) fallback a
 *     nem-superseded nyers dokumentumokon.
 * A `supersededDocIds` a §10.5 szerinti „publikált OKF van rá" dokumentumhalmaz —
 * ezek nyers `extractedText`-je nem jön vissza (nincs nyers + parafrázis duplázás).
 */
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

  // Egy fájlnév-stem egyezés ennyi tartalmi-stem egyezést ér — a keresett
  // dokumentumot a puszta cím-egyezés is a generikus tartalmi találatok elé emeli.
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
    // A fájlnév-stemek a legerősebb „ez a keresett dokumentum" jelzés (a fájlnév a
    // dokumentum egészére vonatkozik, nem egy chunkra). Ezért külön, magasabb
    // súllyal pontozzuk őket: egy hosszú/zajos query esetén így a cél-dokumentum
    // nem hígul fel a sok generikus tartalmi egyezés (más docok chunkjai) mögé.
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

  // 1) Elsődleges: published OKF-chunk full-text találatok navigálható path-szal +
  // oldal/section-szintű forrás-linkkel (§4.7/§9.1).
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
      // A fájlnév a sourceRef VÉGÉN áll, hogy a legacy `/:([^:]+)$/` kinyerés is működjön.
      sourceRef: `okf:${hit.path}:${source.filename ?? hit.title}`,
      memoryVersion: null,
      path: hit.path,
      title: hit.title,
      score: hit.score,
      source,
    } satisfies KbSearchHit
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

  // 2) Legacy stem-scoring (memória + nem-superseded nyers doc) — az OKF UTÁN sorolva.
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

  // 3) Fallback (se OKF, se legacy chunk-egyezés): teljes korpusz a nem-superseded docokon.
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
    .map(({ doc }) => {
      const body = doc.extractedText?.trim()
      const chunk = body
        ? body.split(/\n{2,}|\n(?=-\s+)/).map((part) => part.trim()).find(Boolean) ?? body
        : `[${doc.filename}]`
      return {
        docId: `doc:${doc.id}`,
        snippet: snippet(chunk),
        sourceRef: `doc:${doc.id}:${doc.filename}`,
        memoryVersion: null,
      } satisfies KbSearchHit
    })
}

/** OKF chunk sourceRef (JSON) → tipizált citation-forrás (§4.7). */
function toKbSource(sourceRef: unknown, section: string | null): KbSource {
  const ref = (isRecord(sourceRef) ? sourceRef : {}) as OkfSourceRef
  return {
    documentId: typeof ref.documentId === 'string' ? ref.documentId : undefined,
    filename: typeof ref.filename === 'string' ? ref.filename : undefined,
    page: typeof ref.page === 'number' ? ref.page : undefined,
    section: section ?? (typeof ref.section === 'string' ? ref.section : undefined),
    cell: typeof ref.cell === 'string' ? ref.cell : undefined,
  }
}

/** Egy `path` mélysége az OKF-fában (`pages/01-foo.md` → 2). */
function pathDepth(path: string): number {
  return path.split('/').filter(Boolean).length
}

/**
 * §9.3 — `kb_list_index` tiszta összeállítója: a repo által adott published
 * oldalakat opcionálisan `maxDepth`-ig szűri (a `pathPrefix` szűrést a repo
 * végzi az indexen). DB-mentes, tesztelhető.
 */
export function assembleKbIndex(
  entries: KnowledgeIndexEntry[],
  maxDepth?: number,
): KbListIndexResult {
  const pages = entries
    .filter((e) => maxDepth === undefined || pathDepth(e.path) <= maxDepth)
    .map((e) => ({
      path: e.path,
      title: e.title,
      type: e.type,
      artifactId: e.artifactId,
    }))
  return { pages }
}

/**
 * §9.2 — `kb_get_page` tiszta összeállítója: egy oldal chunkjait (chunkIndex
 * sorrendben) egyetlen szöveggé fűzi, és az oldalcímet + a legelső chunk
 * forrás-linkjét adja vissza (§4.7). DB-mentes, tesztelhető.
 */
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
    text: ordered.map((c) => c.text.trim()).filter(Boolean).join('\n\n'),
    source: toKbSource(first.sourceRef, first.section),
  }
}

export function argsMeta(
  input: ToolBrokerInvokeInput,
  webSearchEffective?: WebSearchEffectiveQuery,
): Record<string, unknown> {
  const base = {
    ticketId: input.ticketId ?? null,
    conversationId: input.conversationId ?? null,
    actingUserId: input.actingUserId ?? null,
  }

  if (input.tool === 'kb_search') {
    return { ...base, queryLength: input.args.query.length, k: input.args.k ?? 5 }
  }

  if (input.tool === 'kb_list_index') {
    return {
      ...base,
      pathPrefix: input.args.pathPrefix ?? null,
      maxDepth: input.args.maxDepth ?? null,
    }
  }

  if (input.tool === 'kb_get_page') {
    return { ...base, path: input.args.path, artifactId: input.args.artifactId ?? null }
  }

  if (input.tool === 'ticket_create') {
    return {
      ...base,
      titleLength: input.args.title.length,
      assigneeType: input.args.assigneeType,
      assigneeId: input.args.assigneeId ?? null,
      parentTicketId: input.ticketId ?? null,
      payloadKeys: Object.keys(input.args.payload).sort(),
    }
  }

  if (input.tool === 'agent_ask') {
    return {
      ...base,
      targetAgentId: input.args.targetAgentId,
      questionLength: input.args.question.length,
      parentTicketId: input.ticketId ?? null,
      hasContext: Boolean(input.args.context && Object.keys(input.args.context).length > 0),
    }
  }

  if (input.tool === 'agent_resolve') {
    return {
      ...base,
      queryLength: input.args.query.length,
      limit: input.args.limit ?? 5,
    }
  }

  if (input.tool === 'agent_catalog') {
    return {
      ...base,
      queryLength: input.args.query?.length ?? 0,
      agentId: input.args.agentId ?? null,
      limit: input.args.limit ?? null,
    }
  }

  if (input.tool === 'user_directory') {
    return {
      ...base,
      queryLength: input.args.query?.length ?? 0,
      limit: input.args.limit ?? null,
    }
  }

  if (input.tool === 'gmail_search') {
    return { ...base, queryLength: input.args.query.length, maxResults: input.args.maxResults ?? 10 }
  }

  if (input.tool === 'gmail_get_message') {
    return { ...base, messageId: input.args.id }
  }

  if (input.tool === 'mailbox_count') {
    return {
      ...base,
      connectorId: input.args.connectorId ?? null,
      queryLength: input.args.query?.length ?? 0,
      labelIds: input.args.labelIds ?? [],
      includeSpamTrash: input.args.includeSpamTrash ?? false,
    }
  }

  if (input.tool === 'gmail_create_draft') {
    return {
      ...base,
      toLength: input.args.to.length,
      subjectLength: input.args.subject.length,
      bodyLength: input.args.body.length,
      hasThreadId: Boolean(input.args.threadId),
    }
  }

  if (input.tool === 'gmail_send') {
    return {
      ...base,
      hasDraftId: Boolean(input.args.draftId),
      approvalTicketId: input.args.approvalTicketId ?? input.ticketId ?? null,
    }
  }

  if (input.tool === 'http_api_get') {
    return {
      ...base,
      connectorId: input.args.connectorId ?? null,
      method: 'GET',
      path: input.args.path,
      queryKeys: Object.keys(input.args.query ?? {}).sort(),
      headerKeys: Object.keys(input.args.headers ?? {}).map((name) => name.toLowerCase()).sort(),
    }
  }

  if (input.tool === 'http_api_get_all') {
    return {
      ...base,
      connectorId: input.args.connectorId ?? null,
      method: 'GET',
      path: input.args.path,
      queryKeys: Object.keys(input.args.query ?? {}).sort(),
      headerKeys: Object.keys(input.args.headers ?? {}).map((name) => name.toLowerCase()).sort(),
      pageParam: input.args.pageParam ?? 'page',
      pageSizeParam: input.args.pageSizeParam ?? 'pageSize',
      pageSize: input.args.pageSize ?? null,
      maxPages: input.args.maxPages ?? null,
      arrayPath: input.args.arrayPath ?? null,
    }
  }

  if (input.tool === 'http_api_request') {
    return {
      ...base,
      connectorId: input.args.connectorId ?? null,
      method: input.args.method,
      path: input.args.path,
      queryKeys: Object.keys(input.args.query ?? {}).sort(),
      headerKeys: Object.keys(input.args.headers ?? {}).map((name) => name.toLowerCase()).sort(),
      hasBody: input.args.body !== undefined,
    }
  }

  if (input.tool === 'repo_prepare') {
    return {
      ...base,
      hasRepoUrl: Boolean(input.args.repoUrl),
      owner: input.args.owner ?? null,
      repo: input.args.repo ?? null,
      ref: input.args.ref ?? null,
      forceRefresh: input.args.forceRefresh ?? false,
    }
  }

  if (input.tool === 'repo_open_pull_request') {
    return {
      ...base,
      titleLength: input.args.title.length,
      hasBody: Boolean(input.args.body),
      branch: input.args.branch ?? null,
      baseRef: input.args.baseRef ?? null,
      draft: input.args.draft ?? false,
    }
  }

  if (input.tool === 'file_read') return { ...base, path: input.args.path, offset: input.args.offset ?? 1, limit: input.args.limit ?? 2000 }
  if (input.tool === 'file_write') return { ...base, path: input.args.path, contentLength: input.args.content.length }
  if (input.tool === 'create_html') return { ...base, path: input.args.path, htmlLength: input.args.html.length }
  if (input.tool === 'file_edit') return { ...base, path: input.args.path, oldStringLength: input.args.old_string.length, replaceAll: input.args.replace_all ?? false }
  if (input.tool === 'file_list') return { ...base, path: input.args.path ?? '', recursive: input.args.recursive ?? false }
  if (input.tool === 'file_glob') return { ...base, pattern: input.args.pattern }
  if (input.tool === 'file_search') return { ...base, pattern: input.args.pattern, path: input.args.path ?? '', glob: input.args.glob ?? null, maxResults: input.args.max_results ?? 100 }
  if (input.tool === 'file_delete') return { ...base, path: input.args.path }
  if (input.tool === 'xlsx_read_sheet') return { ...base, path: input.args.path, sheet: input.args.sheet ?? null, maxRows: input.args.max_rows ?? 500 }
  if (input.tool === 'xlsx_write_cells') return { ...base, path: input.args.path, sheet: input.args.sheet ?? null, cellCount: input.args.changes.length }
  if (input.tool === 'xlsx_format_range') return { ...base, path: input.args.path, sheet: input.args.sheet ?? null, range: input.args.range }
  if (input.tool === 'xlsx_layout') {
    return {
      ...base,
      path: input.args.path,
      sheet: input.args.sheet ?? null,
      mergeCount: input.args.mergeCells?.length ?? 0,
      columnWidthCount: input.args.columnWidths?.length ?? 0,
      rowHeightCount: input.args.rowHeights?.length ?? 0,
      freeze: Boolean(input.args.freeze),
      autoFilter: Boolean(input.args.autoFilter),
    }
  }
  if (input.tool === 'xlsx_create') return { ...base, path: input.args.path, sheetCount: input.args.sheets.length }
  if (input.tool === 'xlsx_append_rows') return { ...base, path: input.args.path, sheet: input.args.sheet ?? null, rowCount: input.args.rows.length }
  if (input.tool === 'docx_read') return { ...base, path: input.args.path }
  if (input.tool === 'docx_create') return { ...base, path: input.args.path, blockCount: input.args.blocks?.length ?? 0 }
  if (input.tool === 'pdf_read') return { ...base, path: input.args.path, pageRange: input.args.page_range ?? null }
  if (input.tool === 'pdf_create') return { ...base, path: input.args.path, sourceXlsx: input.args.source_xlsx ?? null, rowCount: input.args.rows?.length ?? null }
  if (input.tool === 'pptx_create') return { ...base, path: input.args.path, slideCount: input.args.slides?.length ?? 0 }
  if (input.tool === 'sandbox_app.create') return { ...base, name: input.args.name, criticality: input.args.criticality ?? 'L1' }
  if (input.tool === 'sandbox_app.update_artifact') return { ...base, appId: input.args.appId, htmlLength: input.args.html.length, activate: input.args.activate ?? false }
  if (input.tool === 'sandbox_app.preview') return { ...base, appId: input.args.appId, version: input.args.version ?? null }
  if (input.tool === 'sandbox_app.export') return { ...base, appId: input.args.appId, version: input.args.version ?? null }
  if (input.tool === 'sandbox_app.list') return { ...base, search: input.args.search ?? null, status: input.args.status ?? null }
  if (input.tool === 'sandbox_app.get') return { ...base, appId: input.args.appId, version: input.args.version ?? null }
  // §8.2: kód/adattartalom SOHA nem kerül auditba — csak projekt-id, fájldarabszám, path-lista.
  if (input.tool === 'sandbox.commit')
    return {
      ...base,
      projectId: input.args.projectId,
      fileCount: input.args.files.length,
      paths: input.args.files.map((f) => f.path).slice(0, 50),
    }
  if (input.tool === 'sandbox.request_promotion')
    return { ...base, projectId: input.args.projectId, hasReason: Boolean(input.args.reason) }
  if (input.tool === 'sandbox.snapshot')
    return { ...base, projectId: input.args.projectId, env: 'test' }
  if (input.tool === 'web_search') {
    // I-WS-10/WS10: a nyers query SOSEM kerül auditba — csak hossz + hash. A
    // hash-t a policy.authorize() már kiszámolta (webSearchEffective.queryHash);
    // itt csak fallback, ha valamiért nem állt rendelkezésre (sosem fordulhat
    // elő egy 'ok' hívásnál, de defenzív).
    return {
      ...base,
      queryLength: input.args.query.length,
      queryHash:
        webSearchEffective?.queryHash ??
        createHash('sha256').update(input.args.query).digest('hex').slice(0, 16),
      domainsRequested: input.args.domains ?? [],
      recencyDays: input.args.recencyDays ?? null,
      maxResultsRequested: input.args.maxResults ?? null,
      hasPurpose: Boolean(input.args.purpose),
    }
  }
  if (input.tool === 'web_research_request') {
    return {
      ...base,
      objectiveHash: createHash('sha256').update(input.args.objective).digest('hex').slice(0, 16),
      allowedSourceTypes: input.args.allowedSourceTypes ?? [],
      knownDomain: input.args.knownDomain ?? null,
      maxSources: input.args.maxSources ?? null,
    }
  }

  if (input.tool === 'memory_propose') {
    return {
      ...base,
      operation: input.args.operation,
      type: input.args.type ?? null,
      hasSupersedes: Boolean(input.args.supersedes),
    }
  }

  if (input.tool === 'document_read') {
    return {
      ...base,
      documentId: input.args.documentId,
      hasPages: Boolean(input.args.pages),
      hasQuery: Boolean(input.args.query),
      maxChars: input.args.maxChars ?? null,
    }
  }

  if (input.tool === 'tulajdoni_lap_parse') {
    return {
      ...base,
      documentId: input.args.documentId ?? null,
      path: input.args.path ?? null,
      nezet: input.args.nezet ?? 'osszefoglalo',
      csakHatalyos: input.args.csakHatalyos ?? true,
      limit: input.args.limit ?? null,
      offset: input.args.offset ?? null,
      kimenet: input.args.kimenet ?? null,
    }
  }

  if (input.tool === 'tulajdoni_lap_egyeztetes') {
    return {
      ...base,
      documentId: input.args.documentId ?? null,
      path: input.args.path ?? null,
      feldolgozottLapPath: input.args.feldolgozottLapPath ?? null,
      // Csak a MÉRET megy az audit-metába, a névsor maga nem (tartalom-őr).
      nyilvantartasSorok: Array.isArray(input.args.nyilvantartas)
        ? input.args.nyilvantartas.length
        : null,
      nyilvantartasPath: input.args.nyilvantartasPath ?? null,
      kimenet: input.args.kimenet ?? null,
      confirmNyilvantartasComplete: input.args.confirmNyilvantartasComplete === true,
    }
  }

  if (input.tool === 'reconcile_records') {
    return {
      ...base,
      leftPath: input.args.leftPath,
      rightPath: input.args.rightPath,
      outputPath: input.args.outputPath,
      keyFields: input.args.keyFields,
      compareFieldCount: Array.isArray(input.args.compareFields)
        ? input.args.compareFields.length
        : 0,
    }
  }

  return {
    ...base,
    ticketId: input.args.ticketId,
    requestedState: input.args.patch.state ?? null,
    payloadKeys: input.args.patch.payload ? Object.keys(input.args.patch.payload).sort() : [],
  }
}

function isWebSearchResult(value: unknown): value is WebSearchResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'queryMeta' in value &&
    'warnings' in value &&
    'results' in value &&
    Array.isArray((value as { results: unknown }).results)
  )
}

export function resultMeta(result: ToolExecutionResult): Record<string, unknown> {
  // 'in' nem szűri ki a Record<string, string> alakú eredménytípusokat (pl.
  // GmailGetMessageResult), ezért explicit type predicate kell a biztos narrowinghoz.
  if (isWebSearchResult(result)) {
    return {
      provider: result.queryMeta.provider,
      resultCount: result.queryMeta.resultCount,
      domainsEffective: result.queryMeta.domainsEffective,
      recencyDays: result.queryMeta.recencyDays ?? null,
      resultDomains: [...new Set(result.results.map((r) => r.domain))],
      warningCodes: result.warnings.map((w) => w.code),
    }
  }
  if ('status' in result && 'ok' in result && 'body' in result) {
    return {
      status: result.status,
      ok: result.ok,
      ...('truncated' in result && result.truncated ? { truncated: true } : {}),
      ...('hint' in result && typeof result.hint === 'string' ? { hasHint: true } : {}),
    }
  }

  if ('repoPath' in result && 'commitSha' in result) {
    return {
      status: result.status,
      repoPath: result.repoPath,
      owner: result.owner,
      repo: result.repo,
      ref: result.ref,
      commitSha: result.commitSha,
      filesIndexed: result.filesIndexed,
      filesWritten: result.filesWritten,
      filesSkipped: result.filesSkipped,
      bytesWritten: result.bytesWritten,
    }
  }

  if ('changed' in result) {
    return result.changed
      ? {
          changed: true,
          owner: result.owner,
          repo: result.repo,
          branch: result.branch,
          baseRef: result.baseRef,
          commitSha: result.commitSha,
          pullRequestUrl: result.pullRequestUrl,
          pullRequestNumber: result.pullRequestNumber,
          filesChanged: result.filesChanged,
          changedPaths: result.changedPaths,
        }
      : { changed: false, message: result.message }
  }

  if ('ok' in result && !('ticketId' in result) && (('result' in result) || ('error' in result))) {
    const research = result as WebResearchDelegationResult
    if (!research.ok) return { ok: false, error: research.error }
    return {
      ok: true,
      factCount: research.result.facts.length,
      sourceCount: research.result.sources.length,
      overallConfidence: research.result.overallConfidence,
      unverified: research.result.unverified,
    }
  }

  if ('hits' in result && Array.isArray(result.hits)) {
    return {
      hitCount: result.hits.length,
      // §13 — hány találat jött a published OKF-chunk indexből (path-szal) vs. legacy.
      okfHitCount: result.hits.filter((hit: { path?: unknown }) => typeof hit.path === 'string')
        .length,
      memoryVersions: [
        ...new Set(result.hits.map((hit: { memoryVersion?: unknown }) => hit.memoryVersion)),
      ],
    }
  }

  // KB-v3 §9.2/§9.3 — OKF-navigáció (kb_list_index / kb_get_page) audit-metája.
  if ('pages' in result && Array.isArray(result.pages)) {
    return { pageCount: result.pages.length }
  }
  if ('found' in result && 'path' in result) {
    return {
      found: result.found,
      path: result.path,
      artifactId: result.artifactId ?? null,
      textLength: typeof result.text === 'string' ? result.text.length : 0,
    }
  }

  if ('messages' in result && Array.isArray(result.messages)) {
    return { messageCount: result.messages.length }
  }

  if ('count' in result && 'query' in result) {
    return { count: result.count, queryLength: result.query.length }
  }

  if ('users' in result && Array.isArray(result.users)) {
    return {
      userCount: result.users.length,
      roles: [...new Set(result.users.map((u: { role?: unknown }) => u.role))],
    }
  }

  if ('agents' in result && Array.isArray(result.agents)) {
    const first = result.agents[0] as { agentId?: string; score?: number } | undefined
    return {
      matchCount: result.agents.length,
      topAgentId: first?.agentId ?? null,
      topScore: first && 'score' in first ? first.score : undefined,
    }
  }

  if ('draftId' in result && typeof result.draftId === 'string') {
    return { draftId: result.draftId }
  }

  if ('messageId' in result && typeof result.messageId === 'string' && !('ticketId' in result)) {
    return { messageId: result.messageId }
  }

  if ('id' in result && 'body' in result) {
    return { messageId: String(result.id) }
  }

  if ('ok' in result && 'ticketId' in result && 'state' in result) {
    const ask = result as AgentAskResult
    return {
      ok: ask.ok,
      ticketId: ask.ticketId,
      state: ask.state,
      assigneeType: 'assigneeType' in result ? result.assigneeType : undefined,
      assigneeId: 'assigneeId' in result ? result.assigneeId : undefined,
      targetAgentId: ask.targetAgentId,
      requesterAgentId: ask.requesterAgentId,
      completed: ask.completed ?? false,
      hasAnswer: typeof ask.answer === 'string' && ask.answer.length > 0,
    }
  }

  if ('totalLines' in result) return { path: result.path, totalLines: result.totalLines }
  if ('bytesWritten' in result) return { path: result.path, bytesWritten: result.bytesWritten }
  if ('replacements' in result) return { path: result.path, replacements: result.replacements }
  if ('entries' in result) return { path: result.path, count: result.entries.length }
  if ('paths' in result) return { count: result.paths.length }
  if ('matches' in result) return { count: result.matches.length, truncated: result.truncated }
  if ('deleted' in result) return { path: result.path, deleted: result.deleted }
  if ('rowCount' in result && 'headers' in result) return { sheet: result.sheet, rowCount: result.rowCount, headerCount: result.headers.length }
  if ('cellsUpdated' in result) return { path: result.path, cellsUpdated: result.cellsUpdated }
  if ('rowsAppended' in result) return { path: result.path, rowsAppended: result.rowsAppended }
  if ('range' in result) return { path: result.path, range: result.range }
  if ('operations' in result) return { path: result.path, operations: result.operations }
  if ('sheets' in result) return { path: result.path, sheets: result.sheets }
  if ('numPages' in result) return { numPages: result.numPages, pagesRead: result.pagesRead, textLength: result.text.length }
  if ('totalPages' in result && 'pages' in result && 'documentId' in result) {
    return {
      documentId: result.documentId,
      totalPages: result.totalPages,
      pagesReturned: Array.isArray(result.pages) ? result.pages.length : 0,
      truncated: result.truncated ?? false,
      matchCount: 'matchCount' in result ? result.matchCount : undefined,
    }
  }
  if ('text' in result && 'messages' in result) return { textLength: result.text.length, messages: result.messages.length }

  if ('previewUrl' in result) return { previewUrl: result.previewUrl, contentHash: result.contentHash }
  if ('filename' in result && 'contentRef' in result) return { filename: result.filename, contentHash: result.contentHash, sizeBytes: result.sizeBytes }
  // sandbox_app.get: a HTML tartalom SOSE kerül a resultMeta-ba, csak a hossza (§8.2 mintájára).
  if ('html' in result && 'contentHash' in result) {
    return {
      appId: result.appId,
      version: result.version,
      contentHash: result.contentHash,
      htmlLength: typeof result.html === 'string' ? result.html.length : 0,
    }
  }
  if ('apps' in result && Array.isArray(result.apps)) return { appCount: result.apps.length }
  if ('appId' in result && 'status' in result && !('ticketId' in result)) return { appId: result.appId, status: result.status }
  if ('versionId' in result) return { versionId: result.versionId, version: result.version, status: result.status }

  return {}
}

export async function systemUserId(): Promise<string> {
  const user = await prisma.user.findFirst({
    where: { role: 'admin' },
    orderBy: { createdAt: 'asc' },
  })
  if (!user) throw new Error('No system user configured')
  return user.id
}

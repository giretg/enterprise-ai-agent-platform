/**
 * #943 LLM Wiki 2/6 — a wiki MCP-eszközeinek domain-rétege (#941 §3, §5, §6).
 *
 * - `kb_ingest` wiki mód: nyers forrás + tálca-tétel (azonnali feldolgozás
 *   foglalással, vagy `pending`, D6); `kind: note` bélyegzett jegyzet (D9).
 * - `kb_wiki_write`: tervezés (patch, verzió-ütközés), determinisztikus
 *   validáció, mód szerint azonnali alkalmazás vagy jóváhagyásra váró change-set
 *   (D1/D4/D5); alkalmazáskor revízió, chunk-csere, napló, tálca-lezárás egy tranzakcióban.
 * - Tálca: lista + köteg-összesítő, foglalás (`already_claimed`).
 * - Olvasás: `WIKI.md` / `index.md` / `log.md` (generált, D8) és az oldalak.
 *
 * Szerveroldali AI-hívás nincs (D3) — a szintézist a kliens agent végzi.
 */
import type { Connector, Prisma, WikiPage } from '@prisma/client'
import type {
  AgentRepository,
  AuditRepository,
  ConnectorRepository,
  DocumentRepository,
  WikiApplyPageOp,
  WikiChunkRow,
  WikiRepository,
} from '@/repositories/interfaces'
import { redactKbAuditForVisibility } from '@/lib/audit/kb-private-redaction'
import { resolveKbLanguage } from '@/lib/kb-language'
import { chunkWikiPage } from '@/lib/kb-v3'
import { validateWikiPages, type KbValidationIssue, type WikiValidationPage } from '@/lib/kb-validator'
import { kbDocumentOutline } from '@/lib/kb-retrieval'
import {
  WIKI_INDEX_PATH,
  WIKI_LOG_PATH,
  WIKI_SCHEMA_PATH,
  appendToSection,
  defaultWikiSchema,
  extractWikiLinks,
  groupWikiIndex,
  isReservedWikiPath,
  isValidWikiPath,
  mergeWikiSources,
  readWikiSources,
  renderWikiIndex,
  renderWikiLog,
  renderWikiPageMarkdown,
  replaceSection,
  sectionContent,
  stripLeadingFrontmatter,
  stripManagedFrontmatter,
  wikiPageContentHash,
  type WikiPageState,
  type WikiPageTypeName,
  type WikiSourceRef,
} from '@/lib/kb-wiki'
import {
  KB_CATALOG_CONNECTOR_NAME,
  WIKI_CLAIM_TTL_MS,
  canDecideWikiChange,
  effectiveInboxStatus,
  ownerAgentIdForKnowledgeBase,
  resolveWikiApprover,
  resolveWikiScopes,
  resolveWikiTarget,
  type WikiApproverScope,
  type WikiDecider,
  type WikiNeed,
  isKnowledgeBaseVisibleTo,
  type WikiScope,
  type WikiSnapshotConnector,
} from '@/lib/wiki-access'
import { privateKnowledgeBaseDisplayName } from './wiki-access-service'
import type { KnowledgeBaseService } from './knowledge-base-service'

export type WikiCaller = {
  tenantId: string
  userId: string
  agentId: string
  snapshot: { connectors: WikiSnapshotConnector[] }
}

export type WikiFailure = { ok: false; code: string; details?: Record<string, unknown> }
export type WikiOutcome<T = unknown> = { ok: true; result: T } | WikiFailure

/** Jóváhagyásra váró change-set: az MCP-réteg teszi a gateway-sorba (`enqueueWrite`). */
export type WikiApprovalRequest = {
  changeSetId: string
  wikiId: string
  connectorId: string
  /** Közös wikinél path-összesítő a kártyához; privátnál tartalommentes (D13). */
  pages?: Array<{ path: string; action: string }>
  pageCount: number
  /** Közvetlen módban a D5 miatt kivett rész mellett ami már élesedett. */
  applied?: WikiAppliedSummary | null
  /** Ami jóváhagyásra megy, és miért. */
  reason: 'approval_mode' | 'other_authors_page'
}

export type WikiAppliedSummary = {
  changeSetId: string
  pages: Array<{ path: string; action: string; baseVersion: string; status: string }>
}

export type WikiWriteOutcome =
  | { ok: true; result: { status: 'applied'; wikiId: string } & WikiAppliedSummary & Record<string, unknown> }
  | { ok: 'approval'; request: WikiApprovalRequest; result: Record<string, unknown> }
  | WikiFailure

export type WikiPageInput = {
  path: string
  action: 'upsert' | 'patch' | 'archive' | 'move'
  title?: string
  type?: WikiPageTypeName
  summary?: string
  category?: string
  frontmatter?: Record<string, unknown>
  body?: string
  baseVersion?: string
  newPath?: string
  patch?: Array<
    | { op: 'appendToSection'; section: string; text: string }
    | { op: 'replaceSection'; section: string; text: string }
    | { op: 'addSource'; source: WikiSourceRef }
  >
}

export type WikiWriteInput = {
  wikiId?: string
  pages: WikiPageInput[]
  sourceDocumentIds?: string[]
  logEntry?: { op: 'ingest' | 'query' | 'lint' | 'note'; title: string; note?: string }
  inboxItemId?: string
  final?: boolean
}

export type WikiServiceDeps = {
  wikis: WikiRepository
  documents: Pick<DocumentRepository, 'findById'>
  connectors: Pick<ConnectorRepository, 'findById'>
  agents: Pick<AgentRepository, 'findById'>
  knowledgeBase: Pick<KnowledgeBaseService, 'ingest' | 'getDocument'>
  audit: Pick<AuditRepository, 'append'>
  /** A jegyzet bélyegzéséhez (név vagy e-mail); hiányában csak az azonosító. */
  findUserLabel?: (userId: string) => Promise<string | null>
  now?: () => Date
}

export type WikiChangeSetPreview = {
  changeSet: {
    id: string
    status: string
    agentId: string | null
    userId: string | null
    createdAt: Date
    sourceDocumentIds: string[]
    logEntry: { op?: string; title?: string; note?: string | null } | null
  }
  connector: Connector
  pages: Array<{
    path: string
    finalPath: string
    action: WikiPageInput['action']
    /** D5: más agent / ember oldalának archiválása vagy áthelyezése. */
    othersPage: boolean
    status: 'published' | 'archived'
    before: { title: string; summary: string; body: string; status: string } | null
    after: { title: string; summary: string; body: string; sources: WikiSourceRef[] }
  }>
  issues: KbValidationIssue[]
  /** A mostani állapoton a change-set nem alkalmazható (pl. ütközés). */
  blocking: { code: string; details: Record<string, unknown> } | null
}

type Target = { wikiId: string; connector: Connector; scope: WikiScope }

type PlannedPage = {
  input: WikiPageInput
  existing: WikiPage | null
  state: WikiPageState
  status: 'published' | 'archived'
  /** D5: más agent / ember oldalának archiválása vagy áthelyezése. */
  othersPage: boolean
}

type PlanResult =
  | { ok: true; planned: PlannedPage[]; issues: KbValidationIssue[] }
  | WikiFailure

export class WikiService {
  constructor(private readonly deps: WikiServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  // -------------------------------------------------------------------------
  // Cél-wiki feloldása

  /** Az összes olvasható wiki a hívónak (privátnál csak a tulajdonosnak, D13). */
  scopes(caller: WikiCaller) {
    return resolveWikiScopes(caller.snapshot, caller.userId)
  }

  private async resolve(caller: WikiCaller, wikiId: string | undefined, need: WikiNeed): Promise<Target | WikiFailure> {
    const target = await resolveWikiTarget(
      {
        findWikiById: (id) => this.deps.wikis.findById(id),
        findWikiByConnectorId: (connectorId) => this.deps.wikis.findByConnectorId(connectorId),
        findConnector: async (connectorId) => {
          const row = await this.deps.connectors.findById(connectorId, caller.tenantId)
          return row
            ? {
                id: row.id,
                tenantId: row.tenantId,
                type: row.type,
                lifecycleState: row.lifecycleState,
                visibility: row.visibility,
                ownerUserId: row.ownerUserId,
              }
            : null
        },
      },
      { snapshot: caller.snapshot, principal: caller, wikiId, need },
    )
    if (!target.ok) {
      if (target.reason === 'wiki_id_required') {
        return { ok: false, code: 'wiki_id_required', details: { wikis: await this.listWikis(caller, need) } }
      }
      return { ok: false, code: target.reason }
    }
    const connector = await this.deps.connectors.findById(target.connectorId, caller.tenantId)
    if (!connector) return { ok: false, code: 'not_found' }
    const wiki = target.wikiId
      ? { id: target.wikiId }
      : await this.ensureWiki(connector)
    return { wikiId: wiki.id, connector, scope: target.scope }
  }

  /** Egy KB = egy wiki (D11); az első használat hozza létre az alap-sémával. */
  private ensureWiki(connector: Connector) {
    return this.deps.wikis.ensureForConnector({
      connectorId: connector.id,
      schemaMd: defaultWikiSchema(
        resolveKbLanguage(connector.kbLanguage),
        connector.config && typeof connector.config === 'object' && !Array.isArray(connector.config) && connector.config.wikiTemplate === 'health-journal' ? 'health-journal' : 'general',
      ),
    })
  }

  /** A connector-sor `wikiId`-je (olvasáshoz); még nincs wiki → létrejön. */
  async wikiIdForConnector(tenantId: string, connectorId: string): Promise<string | null> {
    const existing = await this.deps.wikis.findByConnectorId(connectorId)
    if (existing) return existing.id
    const connector = await this.deps.connectors.findById(connectorId, tenantId)
    if (!connector || connector.type !== 'knowledge_base') return null
    return (await this.ensureWiki(connector)).id
  }

  async listWikis(caller: WikiCaller, need: WikiNeed = 'read') {
    const scopes = this.scopes(caller)
    const pool = need === 'write' ? scopes.writable : need === 'submit' ? scopes.submittable : scopes.readable
    const now = this.now()
    const summary = await this.deps.wikis.inboxSummary(pool.map((scope) => scope.connectorId), { now })
    const rows = []
    for (const scope of pool) {
      const connector = await this.deps.connectors.findById(scope.connectorId, caller.tenantId)
      if (
        !connector || connector.tenantId !== caller.tenantId || connector.lifecycleState !== 'active' ||
        !isKnowledgeBaseVisibleTo(connector, caller.userId)
      ) continue
      const wiki = await this.ensureWiki(connector)
      const counts = summary.wikis.find((row) => row.connectorId === scope.connectorId)
      rows.push({
        wikiId: wiki.id,
        connectorId: scope.connectorId,
        name: wikiDisplayName(connector),
        access: scope.access,
        ...(scope.access === 'write' ? { writeMode: scope.writeMode } : {}),
        ...(scope.collectFocus ? { collect: scope.collectFocus } : {}),
        ...(scope.visibility === 'private_to_user' ? { private: true } : {}),
        inbox: { pending: counts?.pending ?? 0, inProgress: counts?.inProgress ?? 0 },
        batches: summary.batches
          .filter(batch => batch.connectorId === scope.connectorId)
          .map(batch => ({ batchId: batch.batchId, pending: batch.pending, inProgress: batch.inProgress, processed: batch.processed, skipped: batch.skipped })),
      })
    }
    return rows
  }

  // -------------------------------------------------------------------------
  // kb_ingest processingMode: 'wiki'

  async ingest(
    caller: WikiCaller,
    input: {
      wikiId?: string
      filename?: string
      mimeType?: string | null
      buffer: Buffer
      purpose?: string
      defer?: boolean
      kind?: 'file' | 'note'
    },
  ): Promise<WikiOutcome> {
    if (this.scopes(caller).submittable.length === 0) return { ok: false, code: 'tool_not_configured' }
    const target = await this.resolve(caller, input.wikiId, 'submit')
    if ('ok' in target) return target

    const now = this.now()
    const isNote = input.kind === 'note'
    let buffer = input.buffer
    let filename = input.filename
    let mimeType = input.mimeType ?? null
    let extraMetadata: Record<string, Prisma.InputJsonValue> | undefined
    if (isNote) {
      // D9: a beszélgetésből tanult tudás nyers forrása — ki, mikor.
      const label = (await this.deps.findUserLabel?.(caller.userId)) ?? null
      const stamp = `> Note recorded ${now.toISOString()} by ${label ? `${label} (user ${caller.userId})` : `user ${caller.userId}`} via agent ${caller.agentId}.`
      buffer = Buffer.from(`${stamp}\n\n${input.buffer.toString('utf8').trim()}\n`, 'utf8')
      filename = filename ?? `note-${now.toISOString().replace(/[:.]/g, '-')}.md`
      mimeType = 'text/markdown'
      extraMetadata = {
        kind: 'note',
        note: { recordedByUserId: caller.userId, recordedAt: now.toISOString(), agentId: caller.agentId },
      }
    }

    const stored = await this.deps.knowledgeBase.ingest({
      tenantId: caller.tenantId,
      agentId: caller.agentId,
      uploadedById: caller.userId,
      filename: filename ?? 'source',
      mimeType,
      buffer,
      processingMode: 'raw_text_only',
      purpose: input.purpose,
      actor: 'agent',
      connectorId: target.connector.id,
      extraMetadata,
    })

    // D6: írási jognál azonnali feldolgozás a hívó nevére foglalva; különben tálca.
    const processNow = target.scope.access === 'write' && !input.defer
    const claimExpiresAt = processNow ? new Date(now.getTime() + WIKI_CLAIM_TTL_MS) : null
    await this.deps.wikis.submitToInbox({
      documentId: stored.documentId,
      status: processNow ? 'in_progress' : 'pending',
      submittedByAgentId: caller.agentId,
      claimedByAgentId: processNow ? caller.agentId : null,
      claimExpiresAt,
    })
    await this.audit(target.connector, caller, 'kb.wiki.inbox.submitted', stored.documentId, {
      wikiId: target.wikiId,
      documentId: stored.documentId,
      status: processNow ? 'in_progress' : 'pending',
      kind: isNote ? 'note' : 'file',
    })

    const document = await this.deps.documents.findById(stored.documentId)
    const base = {
      documentId: stored.documentId,
      filename: stored.filename,
      wikiId: target.wikiId,
      inboxItemId: stored.documentId,
      kind: isNote ? 'note' : 'file',
      outline: kbDocumentOutline(document?.extractedText ?? ''),
    }
    if (processNow) {
      return {
        ok: true,
        result: {
          ...base,
          status: 'in_progress',
          claimExpiresAt: claimExpiresAt!.toISOString(),
          nextStep: `Process it now: read the source (kb_get_document documentId, section by section if long), read WIKI.md and index.md (kb_get_page wikiId), then call kb_wiki_write with wikiId, sourceDocumentIds and inboxItemId "${stored.documentId}".`,
        },
      }
    }
    return {
      ok: true,
      result: {
        ...base,
        status: 'pending',
        nextStep:
          target.scope.access === 'write'
            ? 'Saved to the wiki inbox for later, as requested. Process it with kb_get_document claimForWiki:true, then kb_wiki_write inboxItemId.'
            : 'Saved to the wiki inbox. This agent may only submit to this wiki; an agent with write access will process it.',
      },
    }
  }

  // -------------------------------------------------------------------------
  // Tálca

  async listInbox(
    caller: WikiCaller,
    input: { wikiId?: string; batchId?: string; limit?: number },
  ): Promise<WikiOutcome> {
    let connectorIds: string[]
    let wikiFilter: string | null = null
    if (input.wikiId) {
      const target = await this.resolve(caller, input.wikiId, 'read')
      if ('ok' in target) return target
      connectorIds = [target.connector.id]
      wikiFilter = target.wikiId
    } else {
      connectorIds = this.scopes(caller).readable.map((scope) => scope.connectorId)
    }
    const now = this.now()
    const [items, summary] = await Promise.all([
      this.deps.wikis.listInbox(connectorIds, { now, batchId: input.batchId, limit: input.limit }),
      this.deps.wikis.inboxSummary(connectorIds, { now, batchId: input.batchId }),
    ])
    const wikiIds = new Map<string, string | null>()
    for (const connectorId of connectorIds) {
      wikiIds.set(connectorId, wikiFilter ?? (await this.deps.wikis.findByConnectorId(connectorId))?.id ?? null)
    }
    const agentNames = await this.agentNames(
      caller.tenantId,
      items.flatMap((item) => [item.claimedByAgentId, item.submittedByAgentId]),
    )
    return {
      ok: true,
      result: {
        items: items.map((item) => ({
          inboxItemId: item.documentId,
          documentId: item.documentId,
          wikiId: wikiIds.get(item.connectorId) ?? null,
          filename: item.filename,
          purpose: item.purpose,
          status: item.status,
          submittedBy: item.submittedByAgentId
            ? { kind: 'agent', agentId: item.submittedByAgentId, name: agentNames.get(item.submittedByAgentId) ?? null }
            : { kind: 'human', userId: item.uploadedById },
          submittedAt: item.createdAt.toISOString(),
          ...(item.status === 'in_progress'
            ? {
                claimedBy: {
                  agentId: item.claimedByAgentId,
                  name: item.claimedByAgentId ? agentNames.get(item.claimedByAgentId) ?? null : null,
                },
                claimExpiresAt: item.claimExpiresAt?.toISOString() ?? null,
              }
            : {}),
          ...(item.batchId ? { batchId: item.batchId, batchSeq: item.batchSeq } : {}),
        })),
        summary: {
          wikis: summary.wikis.map(({ connectorId, ...counts }) => ({ wikiId: wikiIds.get(connectorId) ?? null, ...counts })),
          batches: summary.batches.map(({ connectorId, ...counts }) => ({ wikiId: wikiIds.get(connectorId) ?? null, ...counts })),
        },
        nextStep:
          items.length > 0
            ? 'Process one item at a time: kb_get_document documentId claimForWiki:true → write the pages → kb_wiki_write inboxItemId. Stop cleanly and report progress when your session budget runs low.'
            : 'The inbox is empty.',
      },
    }
  }

  /** `kb_get_document claimForWiki: true` — a hívó agentre foglal (2 óra). */
  async claim(caller: WikiCaller, input: { connectorId: string; documentId: string }): Promise<WikiOutcome<{ claimExpiresAt: string; wikiId: string }>> {
    const writable = this.scopes(caller).writable.some((scope) => scope.connectorId === input.connectorId)
    if (!writable) return { ok: false, code: 'wiki_write_not_allowed' }
    const now = this.now()
    const claimed = await this.claimFor(caller, input.connectorId, input.documentId, now)
    if (!claimed.ok) return claimed
    const connector = await this.deps.connectors.findById(input.connectorId, caller.tenantId)
    const wikiId = (await this.wikiIdForConnector(caller.tenantId, input.connectorId)) ?? ''
    if (connector) {
      await this.audit(connector, caller, 'kb.wiki.inbox.claimed', input.documentId, {
        wikiId,
        documentId: input.documentId,
      })
    }
    return { ok: true, result: { claimExpiresAt: claimed.expiresAt.toISOString(), wikiId } }
  }

  private async claimFor(
    caller: WikiCaller,
    connectorId: string,
    documentId: string,
    now: Date,
  ): Promise<{ ok: true; expiresAt: Date } | WikiFailure> {
    const expiresAt = new Date(now.getTime() + WIKI_CLAIM_TTL_MS)
    const ok = await this.deps.wikis.claimInboxItem({ documentId, connectorId, agentId: caller.agentId, now, expiresAt })
    if (ok) return { ok: true, expiresAt }
    const document = await this.deps.documents.findById(documentId)
    if (!document || document.connectorId !== connectorId) return { ok: false, code: 'not_found' }
    const status = effectiveInboxStatus(document, now)
    if (status === 'in_progress' && document.wikiClaimedByAgentId) {
      const names = await this.agentNames(caller.tenantId, [document.wikiClaimedByAgentId])
      return {
        ok: false,
        code: 'already_claimed',
        details: {
          claimedBy: { agentId: document.wikiClaimedByAgentId, name: names.get(document.wikiClaimedByAgentId) ?? null },
          claimExpiresAt: document.wikiClaimExpiresAt?.toISOString() ?? null,
        },
      }
    }
    return { ok: false, code: 'not_in_inbox', details: { status } }
  }

  // -------------------------------------------------------------------------
  // Olvasás

  /**
   * Wiki-path olvasása. `null` = ez nem wiki-olvasás (az OKF-út folytatódik):
   * `index.md` csak `wikiId`-vel vagy nem üres wikinél megy ide, hogy a meglévő
   * OKF-tartalomjegyzékek viselkedése ne változzon.
   */
  async readPage(input: {
    tenantId: string
    connectorId: string
    path: string
    explicitWiki: boolean
  }): Promise<Record<string, unknown> | null> {
    const wiki = input.explicitWiki
      ? await this.deps.wikis.findById((await this.wikiIdForConnector(input.tenantId, input.connectorId)) ?? '')
      : await this.deps.wikis.findByConnectorId(input.connectorId)
    if (!wiki) return null
    const path = input.path.trim().replace(/^\/+/, '')
    if (path === WIKI_SCHEMA_PATH || path.toLowerCase() === 'wiki.md') {
      return { found: true, kind: 'wiki_schema', wikiId: wiki.id, path: WIKI_SCHEMA_PATH, text: wiki.schemaMd }
    }
    if (path === WIKI_LOG_PATH) {
      const entries = await this.deps.wikis.listLog(wiki.id, 1000)
      return { found: true, kind: 'wiki_log', wikiId: wiki.id, path, text: renderWikiLog(entries) }
    }
    if (path === WIKI_INDEX_PATH) {
      const pages = await this.deps.wikis.listPages(input.connectorId, { status: 'published' })
      if (!input.explicitWiki && pages.length === 0) return null
      return { found: true, kind: 'wiki_index', wikiId: wiki.id, path, pageCount: pages.length, text: renderWikiIndex(pages) }
    }
    const page = await this.deps.wikis.findPage(input.connectorId, path)
    if (!page) return input.explicitWiki ? { found: false, wikiId: wiki.id, path } : null
    const state = stateFromRow(page)
    return {
      found: true,
      kind: 'wiki_page',
      wikiId: wiki.id,
      path: page.path,
      type: page.type,
      title: page.title,
      summary: page.summary,
      category: page.category,
      status: page.status,
      sources: state.sources,
      outLinks: page.outLinks,
      baseVersion: page.contentHash,
      version: page.version,
      updatedAt: page.updatedAt.toISOString(),
      createdBy: page.createdByAgentId
        ? { kind: 'agent', agentId: page.createdByAgentId }
        : page.createdByUserId
          ? { kind: 'human', userId: page.createdByUserId }
          : null,
      text: renderWikiPageMarkdown(state),
    }
  }

  /** `kb_list_index` elejére: a wiki tartalomjegyzéke kategóriánként (D8). */
  async indexFor(tenantId: string, connectorId: string, caller: WikiCaller) {
    const scope = this.scopes(caller).readable.find((row) => row.connectorId === connectorId)
    if (!scope) return null
    const wikiId = await this.wikiIdForConnector(tenantId, connectorId)
    if (!wikiId) return null
    const pages = await this.deps.wikis.listPages(connectorId, { status: 'published' })
    const connector = await this.deps.connectors.findById(connectorId, tenantId)
    return {
      wikiId,
      name: connector ? wikiDisplayName(connector) : null,
      access: scope.access,
      ...(scope.access === 'write' ? { writeMode: scope.writeMode } : {}),
      ...(scope.collectFocus ? { collect: scope.collectFocus } : {}),
      pageCount: pages.length,
      categories: groupWikiIndex(pages).map((group) => ({
        category: group.category,
        pages: group.pages.map((page) => ({ path: page.path, title: page.title, summary: page.summary, type: page.type })),
      })),
      hint: 'Read a page with kb_get_page wikiId + path; the rules are in path "WIKI.md".',
    }
  }

  // -------------------------------------------------------------------------
  // kb_wiki_write

  async write(caller: WikiCaller, input: WikiWriteInput): Promise<WikiWriteOutcome> {
    const target = await this.resolve(caller, input.wikiId, 'write')
    if ('ok' in target) return target
    const { connector, wikiId, scope } = target
    const now = this.now()
    const sourceDocumentIds = [...new Set(input.sourceDocumentIds ?? [])]

    const plan = await this.plan({ connectorId: connector.id, agentId: caller.agentId, pages: input.pages, sourceDocumentIds })
    if (!plan.ok) return plan

    // Tálca-tétel: a hívó foglalja (pending / lejárt / saját); másé → already_claimed.
    if (input.inboxItemId) {
      const claimed = await this.claimFor(caller, connector.id, input.inboxItemId, now)
      if (!claimed.ok) return claimed
    }
    const final = input.final ?? true
    const approverScope = await this.approverScopeFor(connector)

    // D5: más oldalának archiválása / áthelyezése mindig jóváhagyással.
    const needsApproval = (page: PlannedPage) => scope.writeMode !== 'direct' || page.othersPage
    const directPages = plan.planned.filter((page) => !needsApproval(page))
    const approvalPages = plan.planned.filter(needsApproval)
    const log = {
      op: input.logEntry?.op ?? (input.inboxItemId || sourceDocumentIds.length ? 'ingest' : 'note'),
      title: input.logEntry?.title?.trim() || `Updated ${plan.planned.length} page${plan.planned.length === 1 ? '' : 's'}`,
      note: input.logEntry?.note ?? null,
    } as const
    const validation = { issues: plan.issues } as unknown as Prisma.InputJsonValue

    let applied: WikiAppliedSummary | null = null
    if (directPages.length > 0) {
      const result = await this.apply({
        caller,
        connector,
        wikiId,
        planned: directPages,
        changeSet: {
          create: {
            wikiId,
            connectorId: connector.id,
            agentId: caller.agentId,
            userId: caller.userId,
            pages: directPages.map((page) => page.input) as unknown as Prisma.InputJsonValue,
            validation,
            logEntry: log as unknown as Prisma.InputJsonValue,
            sourceDocumentIds,
            inboxItemId: input.inboxItemId ?? null,
            approverScope: approverScope as unknown as Prisma.InputJsonValue,
          },
        },
        log,
        // A tálca-tételt a közvetlen rész zárja le; a D5 miatt kivett oldalak külön mennek.
        inbox: input.inboxItemId
          ? { documentId: input.inboxItemId, final, agentId: caller.agentId, claimExpiresAt: new Date(now.getTime() + WIKI_CLAIM_TTL_MS) }
          : null,
      })
      if (!result.ok) return result
      applied = result.result
    }

    const warnings = plan.issues.filter((issue) => issue.severity === 'warning')
    if (approvalPages.length === 0) {
      return {
        ok: true,
        result: {
          status: 'applied',
          wikiId,
          ...applied!,
          ...(input.inboxItemId ? { inboxItemId: input.inboxItemId, inboxStatus: final ? 'processed' : 'in_progress' } : {}),
          ...(warnings.length ? { warnings } : {}),
        },
      }
    }

    const pending = await this.deps.wikis.createChangeSet({
      wikiId,
      connectorId: connector.id,
      agentId: caller.agentId,
      userId: caller.userId,
      status: 'pending',
      pages: approvalPages.map((page) => page.input) as unknown as Prisma.InputJsonValue,
      validation,
      logEntry: log as unknown as Prisma.InputJsonValue,
      sourceDocumentIds,
      inboxItemId: applied ? null : (input.inboxItemId ?? null),
      approverScope: approverScope as unknown as Prisma.InputJsonValue,
    })
    if (input.inboxItemId && !applied && final) {
      // Jóváhagyásig se dolgozza fel más; elutasításkor visszakerül a tálcára.
      await this.deps.wikis.markInboxProcessed({ documentId: input.inboxItemId, changeSetId: pending.id })
    }
    await this.audit(connector, caller, 'kb.wiki.changeset.submitted', pending.id, {
      wikiId,
      changeSetId: pending.id,
      pageCount: approvalPages.length,
      reason: scope.writeMode === 'direct' ? 'other_authors_page' : 'approval_mode',
    })
    const shared = scope.visibility !== 'private_to_user'
    return {
      ok: 'approval',
      request: {
        changeSetId: pending.id,
        wikiId,
        connectorId: connector.id,
        pageCount: approvalPages.length,
        ...(shared ? { pages: approvalPages.map((page) => ({ path: page.input.path, action: page.input.action })) } : {}),
        applied,
        reason: scope.writeMode === 'direct' ? 'other_authors_page' : 'approval_mode',
      },
      result: {
        wikiId,
        changeSetId: pending.id,
        pendingPages: approvalPages.map((page) => ({ path: page.input.path, action: page.input.action })),
        ...(applied ? { applied } : {}),
        ...(warnings.length ? { warnings } : {}),
        note:
          scope.writeMode === 'direct'
            ? 'Archiving or moving a page created by another agent or a person always needs approval (the rest was applied).'
            : 'This wiki needs approval: the change is not readable or searchable until the wiki owner approves it.',
      },
    }
  }

  /** D4: a jóváhagyó a wiki gazdája (privát: tulajdonos; saját: tulajdonos agent jóváhagyója; közös: admin). */
  async approverScopeFor(connector: Connector): Promise<WikiApproverScope> {
    const ownerAgentId = ownerAgentIdForKnowledgeBase(connector.name)
    const ownerAgent = ownerAgentId ? await this.deps.agents.findById(ownerAgentId, connector.tenantId) : null
    return resolveWikiApprover({
      connector,
      ownerAgent: ownerAgent ? { id: ownerAgent.id, approverUserId: ownerAgent.approverUserId } : null,
    })
  }

  async approverScopeForConnector(tenantId: string, connectorId: string): Promise<WikiApproverScope | null> {
    const connector = await this.deps.connectors.findById(connectorId, tenantId)
    if (!connector || connector.type !== 'knowledge_base') return null
    return this.approverScopeFor(connector)
  }

  /** Csak a change-set rögzített jóváhagyó-köre dönthet (privátnál admin sem). */
  async canDecide(actor: WikiDecider & { tenantId: string }, changeSetId: string): Promise<boolean> {
    const changeSet = await this.deps.wikis.findChangeSet(changeSetId)
    if (!changeSet) return false
    const connector = await this.deps.connectors.findById(changeSet.connectorId, actor.tenantId)
    if (!connector || connector.tenantId !== actor.tenantId) return false
    const scope = parseApproverScope(changeSet.approverScope)
    return scope ? canDecideWikiChange(actor, scope) : false
  }

  /** Jóváhagyás után: újratervezés a friss állapoton (patch újra alkalmazva), majd alkalmazás. */
  async applyApproved(caller: WikiCaller, changeSetId: string): Promise<WikiOutcome> {
    const changeSet = await this.deps.wikis.findChangeSet(changeSetId)
    if (!changeSet || changeSet.status !== 'pending') return { ok: false, code: 'changeset_not_pending' }
    const target = await this.resolve(caller, changeSet.wikiId, 'write')
    if ('ok' in target) return target
    if (target.connector.id !== changeSet.connectorId) return { ok: false, code: 'not_found' }
    const pages = (Array.isArray(changeSet.pages) ? changeSet.pages : []) as unknown as WikiPageInput[]
    const plan = await this.plan({
      connectorId: changeSet.connectorId,
      agentId: changeSet.agentId ?? caller.agentId,
      pages,
      sourceDocumentIds: changeSet.sourceDocumentIds,
    })
    if (!plan.ok) {
      await this.reject(changeSetId, { tenantId: caller.tenantId, actorUserId: null, reason: plan.code })
      return plan
    }
    const stored = (changeSet.logEntry ?? {}) as { op?: string; title?: string; note?: string | null }
    const result = await this.apply({
      caller,
      connector: target.connector,
      wikiId: changeSet.wikiId,
      planned: plan.planned,
      changeSet: { id: changeSetId },
      log: {
        op: (stored.op as 'ingest') ?? 'ingest',
        title: stored.title ?? `Updated ${plan.planned.length} pages`,
        note: stored.note ?? null,
      },
      inbox: null,
    })
    if (!result.ok) {
      if (result.code === 'conflict') {
        await this.reject(changeSetId, { tenantId: caller.tenantId, actorUserId: null, reason: 'conflict' })
      }
      return result
    }
    await this.audit(target.connector, caller, 'kb.wiki.changeset.approved', changeSetId, {
      wikiId: changeSet.wikiId,
      changeSetId,
    })
    return { ok: true, result: { status: 'applied', wikiId: changeSet.wikiId, ...result.result } }
  }

  /** Elutasítás: a change-set `rejected`, a hozzá lezárt tálca-tétel vissza a tálcára. */
  async reject(changeSetId: string, input: { tenantId: string; actorUserId: string | null; reason?: string }) {
    const changeSet = await this.deps.wikis.transitionChangeSet(changeSetId, 'pending', 'rejected')
    if (!changeSet) return false
    if (changeSet.inboxItemId) {
      await this.deps.wikis.reopenInboxItem({ documentId: changeSet.inboxItemId, changeSetId })
    }
    const connector = await this.deps.connectors.findById(changeSet.connectorId, input.tenantId)
    if (connector) {
      await this.deps.audit.append(
        redactKbAuditForVisibility(connector, {
          actorType: input.actorUserId ? 'human' : 'system',
          actorId: input.actorUserId,
          agentVersion: null,
          action: 'kb.wiki.changeset.rejected',
          targetType: 'wiki_change_set',
          targetId: changeSetId,
          modelUsed: null,
          inputRef: null,
          outputRef: null,
          policyDecision: 'denied',
          metadata: { wikiId: changeSet.wikiId, changeSetId, connectorId: connector.id, ...(input.reason ? { kind: input.reason } : {}) },
          tenantId: input.tenantId,
        }),
      )
    }
    return true
  }

  /**
   * #946 jóváhagyó kártya: a change-set oldalai a mostani állapothoz képest,
   * írás nélkül (ugyanaz a tervezés, mint jóváhagyáskor). Jogot nem ellenőriz.
   */
  async previewChangeSet(tenantId: string, changeSetId: string): Promise<WikiChangeSetPreview | null> {
    const changeSet = await this.deps.wikis.findChangeSet(changeSetId)
    if (!changeSet) return null
    const connector = await this.deps.connectors.findById(changeSet.connectorId, tenantId)
    if (!connector || connector.tenantId !== tenantId || connector.type !== 'knowledge_base') return null
    const inputs = (Array.isArray(changeSet.pages) ? changeSet.pages : []) as unknown as WikiPageInput[]
    const plan = await this.plan({
      connectorId: changeSet.connectorId,
      agentId: changeSet.agentId ?? '',
      pages: inputs,
      sourceDocumentIds: changeSet.sourceDocumentIds,
    })
    const stored = changeSet.validation && typeof changeSet.validation === 'object' ? changeSet.validation : {}
    const storedIssues = Array.isArray((stored as { issues?: unknown }).issues)
      ? ((stored as { issues: KbValidationIssue[] }).issues)
      : []
    const pages: WikiChangeSetPreview['pages'] = plan.ok
      ? plan.planned.map((page) => ({
          path: page.input.path,
          finalPath: page.state.path,
          action: page.input.action,
          othersPage: page.othersPage,
          status: page.status,
          before: page.existing
            ? { title: page.existing.title, summary: page.existing.summary, body: page.existing.body, status: page.existing.status }
            : null,
          after: { title: page.state.title, summary: page.state.summary, body: page.state.body, sources: page.state.sources },
        }))
      : inputs.map((page) => ({
          path: page.path,
          finalPath: page.action === 'move' ? page.newPath ?? page.path : page.path,
          action: page.action,
          othersPage: false,
          status: page.action === 'archive' ? 'archived' : 'published',
          before: null,
          after: { title: page.title ?? '', summary: page.summary ?? '', body: page.body ?? '', sources: [] },
        }))
    return {
      changeSet: {
        id: changeSet.id,
        status: changeSet.status,
        agentId: changeSet.agentId,
        userId: changeSet.userId,
        createdAt: changeSet.createdAt,
        sourceDocumentIds: changeSet.sourceDocumentIds,
        logEntry: (changeSet.logEntry ?? null) as WikiChangeSetPreview['changeSet']['logEntry'],
      },
      connector,
      pages,
      issues: plan.ok ? plan.issues : storedIssues,
      blocking: plan.ok ? null : { code: plan.code, details: plan.details ?? {} },
    }
  }

  // -------------------------------------------------------------------------
  // Tervezés + validáció (determinisztikus, írás előtt)

  private async plan(input: {
    connectorId: string
    agentId: string
    pages: WikiPageInput[]
    sourceDocumentIds: string[]
  }): Promise<PlanResult> {
    const issues: KbValidationIssue[] = []
    const conflicts: Array<Record<string, unknown>> = []
    const planned: PlannedPage[] = []
    const fallbackSources: WikiSourceRef[] = input.sourceDocumentIds.map((documentId) => ({ documentId }))
    const touched = new Set<string>()
    const error = (path: string, code: string, message: string) =>
      issues.push({ severity: 'error', code, path, message })

    const published = await this.deps.wikis.listPages(input.connectorId, { status: 'published' })
    const pathsAfterWrite = new Set(published.map((page) => page.path))

    for (const page of input.pages) {
      const path = page.path.trim()
      const finalPath = page.action === 'move' ? page.newPath?.trim() ?? '' : path
      if (!isValidWikiPath(path) || isReservedWikiPath(path)) {
        error(path, isReservedWikiPath(path) ? 'reserved_path' : 'invalid_path', isReservedWikiPath(path)
          ? 'index.md, log.md and WIKI.md are generated or human-edited; do not write them.'
          : 'Path must match ^[a-z0-9-/]+\\.md$ (e.g. entities/teya.md).')
        continue
      }
      for (const key of new Set([path, finalPath])) {
        if (touched.has(key)) error(path, 'duplicate_path', `${key} appears more than once in this change-set.`)
        touched.add(key)
      }
      const existing = await this.deps.wikis.findPage(input.connectorId, path)
      const othersPage = !!existing && (existing.createdByAgentId !== input.agentId || !!existing.createdByUserId)

      if (page.action === 'upsert') {
        if (existing && existing.status === 'published' && page.baseVersion !== existing.contentHash) {
          conflicts.push(conflictPayload(existing, page.baseVersion ? 'baseVersion is stale' : 'page exists — read it and pass baseVersion'))
          continue
        }
        const { body, stripped } = stripLeadingFrontmatter(page.body ?? '')
        if (stripped) {
          issues.push({ severity: 'warning', code: 'frontmatter_in_body', path, message: 'Frontmatter in body was ignored; pass fields separately.' })
        }
        const sources = readWikiSources(page.frontmatter?.sources)
        const state: WikiPageState = {
          path,
          type: (page.type ?? (page.frontmatter?.type as WikiPageTypeName) ?? 'entity') as WikiPageTypeName,
          title: (page.title ?? stringField(page.frontmatter?.title)).trim(),
          summary: (page.summary ?? stringField(page.frontmatter?.summary)).trim(),
          category: (page.category ?? stringField(page.frontmatter?.category)).trim() || null,
          frontmatter: stripManagedFrontmatter(page.frontmatter),
          body,
          sources: sources.length ? sources : fallbackSources,
        }
        if (!page.type && !page.frontmatter?.type) error(path, 'missing_field', 'type is required.')
        planned.push({ input: page, existing, state, status: 'published', othersPage: false })
        pathsAfterWrite.add(path)
        continue
      }

      if (!existing) {
        error(path, 'page_not_found', `No page at ${path}; use action "upsert" to create it.`)
        continue
      }
      const current = stateFromRow(existing)

      if (page.action === 'patch') {
        if (!page.patch?.length && page.title === undefined && page.summary === undefined && page.category === undefined) {
          error(path, 'empty_patch', 'patch needs at least one operation.')
          continue
        }
        if (page.baseVersion && page.baseVersion !== existing.contentHash) {
          // Más fejezetet érintő közbeni írás nem ütközés; ugyanaz a fejezet igen.
          const base = (await this.deps.wikis.listRevisions(existing.id)).find((rev) => rev.contentHash === page.baseVersion)
          const touchedSections = (page.patch ?? []).flatMap((op) => ('section' in op ? [op.section] : []))
          const sectionChanged =
            !base ||
            touchedSections.some((section) => sectionContent(base.body, section) !== sectionContent(existing.body, section)) ||
            (touchedSections.length === 0 && (page.title !== undefined || page.summary !== undefined))
          if (sectionChanged) {
            conflicts.push(conflictPayload(existing, 'the section you patch changed since baseVersion'))
            continue
          }
        }
        let body = current.body
        let sources = current.sources
        for (const op of page.patch ?? []) {
          if (op.op === 'appendToSection') body = appendToSection(body, op.section, op.text)
          else if (op.op === 'replaceSection') {
            const next = replaceSection(body, op.section, op.text)
            if (next === null) error(path, 'section_not_found', `No section "${op.section}" on ${path}.`)
            else body = next
          } else sources = mergeWikiSources(sources, [op.source])
        }
        if (fallbackSources.length) sources = mergeWikiSources(sources, fallbackSources)
        planned.push({
          input: page,
          existing,
          state: {
            ...current,
            title: page.title?.trim() || current.title,
            summary: page.summary?.trim() || current.summary,
            category: page.category !== undefined ? page.category.trim() || null : current.category,
            body,
            sources,
          },
          status: existing.status === 'archived' ? 'archived' : 'published',
          othersPage: false,
        })
        continue
      }

      if (page.action === 'archive') {
        pathsAfterWrite.delete(path)
        planned.push({ input: page, existing, state: current, status: 'archived', othersPage })
        continue
      }

      // move
      if (!isValidWikiPath(finalPath) || isReservedWikiPath(finalPath)) {
        error(path, 'invalid_path', 'newPath must match ^[a-z0-9-/]+\\.md$ and must not be index.md, log.md or WIKI.md.')
        continue
      }
      if (await this.deps.wikis.findPage(input.connectorId, finalPath)) {
        error(path, 'path_taken', `A page already exists at ${finalPath}.`)
        continue
      }
      pathsAfterWrite.delete(path)
      pathsAfterWrite.add(finalPath)
      planned.push({ input: page, existing, state: { ...current, path: finalPath }, status: existing.status === 'archived' ? 'archived' : 'published', othersPage })
    }

    // D9: forrás = ugyanebben a KB-ban létező nyers dokumentum.
    const referenced = new Set([
      ...input.sourceDocumentIds,
      ...planned.flatMap((page) => page.state.sources.map((ref) => ref.documentId)),
    ])
    const knownSourceIds = new Set<string>()
    for (const documentId of referenced) {
      const document = /^[0-9a-f-]{36}$/i.test(documentId) ? await this.deps.documents.findById(documentId) : null
      if (document && document.connectorId === input.connectorId && document.status === 'processed') {
        knownSourceIds.add(documentId)
      }
    }
    for (const documentId of input.sourceDocumentIds) {
      if (!knownSourceIds.has(documentId)) {
        error('(sourceDocumentIds)', 'unknown_source', `Source ${documentId} is not a raw source in this knowledge base.`)
      }
    }

    const validation = validateWikiPages({
      pages: planned.map((page): WikiValidationPage => ({
        path: page.input.path,
        action: page.status === 'archived' && page.input.action !== 'patch' ? 'archive' : page.input.action,
        state: page.state,
      })),
      knownSourceIds,
      pathsAfterWrite,
    })
    issues.push(...validation.issues)

    const errors = issues.filter((issue) => issue.severity === 'error')
    if (errors.length > 0) {
      return {
        ok: false,
        code: 'invalid_wiki_change',
        details: {
          errors,
          ...(conflicts.length ? { conflicts } : {}),
          hint: 'Nothing was written. Fix every error and call kb_wiki_write again with the whole change-set.',
        },
      }
    }
    if (conflicts.length > 0) {
      return {
        ok: false,
        code: 'conflict',
        details: {
          conflicts,
          hint: 'Nothing was written. Merge your change into the current content and retry with the new baseVersion.',
        },
      }
    }
    return { ok: true, planned, issues }
  }

  private async apply(input: {
    caller: WikiCaller
    connector: Connector
    wikiId: string
    planned: PlannedPage[]
    changeSet: Parameters<WikiRepository['applyChangeSet']>[0]['changeSet']
    log: { op: 'ingest' | 'query' | 'lint' | 'note'; title: string; note: string | null }
    inbox: Parameters<WikiRepository['applyChangeSet']>[0]['inbox']
  }): Promise<WikiOutcome<WikiAppliedSummary>> {
    const { caller, connector } = input
    const ops: WikiApplyPageOp[] = input.planned.map((page) => {
      const write = toPageWrite(page)
      const chunks = page.status === 'archived' ? [] : pageChunks(page.state)
      if (!page.existing) {
        return { kind: 'create', page: write, createdByAgentId: caller.agentId, chunks }
      }
      return {
        kind: 'update',
        pageId: page.existing.id,
        expectedVersion: page.existing.version,
        previousPath: page.existing.path,
        page: write,
        updatedByAgentId: caller.agentId,
        chunks,
      }
    })
    const result = await this.deps.wikis.applyChangeSet({
      changeSet: input.changeSet,
      wikiId: input.wikiId,
      connectorId: connector.id,
      ops,
      log: {
        ...input.log,
        pagePaths: input.planned.map((page) => page.state.path),
        actorAgentId: caller.agentId,
        actorUserId: caller.userId,
      },
      inbox: input.inbox,
      appliedAt: this.now(),
    })
    if (!result.ok) {
      if (result.reason === 'changeset_not_pending') return { ok: false, code: 'changeset_not_pending' }
      const existing = result.path ? await this.deps.wikis.findPage(connector.id, result.path) : null
      return {
        ok: false,
        code: 'conflict',
        details: {
          conflicts: existing ? [conflictPayload(existing, 'another write landed first')] : [],
          hint: 'Nothing was written. Read the page again and retry with the new baseVersion.',
        },
      }
    }

    await this.audit(connector, caller, 'kb.wiki.changeset.applied', result.changeSetId, {
      wikiId: input.wikiId,
      changeSetId: result.changeSetId,
      pageCount: result.pages.length,
    })
    for (const [i, page] of result.pages.entries()) {
      const planned = input.planned[i]
      await this.audit(
        connector,
        caller,
        !planned.existing ? 'kb.wiki.page.created' : page.status === 'archived' ? 'kb.wiki.page.archived' : 'kb.wiki.page.updated',
        page.id,
        { wikiId: input.wikiId, pageId: page.id, changeSetId: result.changeSetId, action: planned.input.action, path: page.path },
        'wiki_page',
      )
    }
    if (input.inbox?.final) {
      await this.audit(connector, caller, 'kb.wiki.inbox.processed', input.inbox.documentId, {
        wikiId: input.wikiId,
        documentId: input.inbox.documentId,
        changeSetId: result.changeSetId,
      })
    }
    return {
      ok: true,
      result: {
        changeSetId: result.changeSetId,
        pages: result.pages.map((page, i) => ({
          path: page.path,
          action: input.planned[i].input.action,
          baseVersion: page.contentHash,
          status: page.status,
        })),
      },
    }
  }

  private async agentNames(tenantId: string, ids: Array<string | null>): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    for (const id of new Set(ids.filter((value): value is string => !!value))) {
      const agent = await this.deps.agents.findById(id, tenantId)
      if (agent) names.set(id, agent.name)
    }
    return names
  }

  private async audit(
    connector: Connector,
    caller: WikiCaller,
    action: string,
    targetId: string,
    metadata: Record<string, unknown>,
    targetType = action.startsWith('kb.wiki.inbox') ? 'document' : 'wiki_change_set',
  ) {
    await this.deps.audit.append(
      redactKbAuditForVisibility(connector, {
        actorType: 'agent',
        actorId: caller.agentId,
        agentVersion: null,
        action,
        targetType,
        targetId,
        modelUsed: null,
        inputRef: null,
        outputRef: connector.id,
        policyDecision: 'allowed',
        metadata: { ...metadata, agentId: caller.agentId, userId: caller.userId, connectorId: connector.id },
        tenantId: caller.tenantId,
      }),
    )
  }
}

// ---------------------------------------------------------------------------

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function wikiDisplayName(connector: Pick<Connector, 'name' | 'config' | 'visibility'>): string {
  if (connector.visibility === 'private_to_user') return privateKnowledgeBaseDisplayName(connector) ?? 'Private knowledge base'
  if (connector.name === KB_CATALOG_CONNECTOR_NAME) return 'Company knowledge base'
  if (ownerAgentIdForKnowledgeBase(connector.name)) return 'Agent knowledge base'
  // #946: a Control Plane-en létrehozott közös KB neve a configban él.
  return privateKnowledgeBaseDisplayName(connector) ?? connector.name
}

function stateFromRow(page: WikiPage): WikiPageState {
  return {
    path: page.path,
    type: page.type,
    title: page.title,
    summary: page.summary,
    category: page.category,
    frontmatter: stripManagedFrontmatter(page.frontmatter),
    body: page.body,
    sources: readWikiSources(page.sourceRefs),
  }
}

function conflictPayload(page: WikiPage, reason: string) {
  const state = stateFromRow(page)
  return {
    path: page.path,
    reason,
    baseVersion: page.contentHash,
    current: {
      type: state.type,
      title: state.title,
      summary: state.summary,
      category: state.category,
      frontmatter: state.frontmatter,
      sources: state.sources,
      body: state.body,
    },
  }
}

function toPageWrite(page: PlannedPage) {
  const { state } = page
  return {
    path: state.path,
    type: state.type,
    title: state.title,
    summary: state.summary,
    category: state.category,
    frontmatter: state.frontmatter as Prisma.InputJsonValue,
    body: state.body,
    sourceRefs: state.sources as unknown as Prisma.InputJsonValue,
    outLinks: extractWikiLinks(state.body, state.path),
    status: page.status,
    contentHash: wikiPageContentHash(state),
  }
}

function pageChunks(state: WikiPageState): WikiChunkRow[] {
  return chunkWikiPage({
    path: state.path,
    title: state.title,
    type: state.type,
    summary: state.summary,
    body: state.body,
    sources: state.sources,
  }).map((chunk) => ({
    path: chunk.path,
    title: chunk.title,
    type: chunk.type,
    section: chunk.section,
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    sourceRef: (chunk.sourceRef ?? null) as Prisma.InputJsonValue | null,
    contentHash: chunk.contentHash,
  }))
}

function parseApproverScope(value: unknown): WikiApproverScope | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (row.kind === 'owner_user' && typeof row.userId === 'string') return { kind: 'owner_user', userId: row.userId }
  const approverUserId = typeof row.approverUserId === 'string' ? row.approverUserId : null
  if (row.kind === 'agent_owner' && typeof row.agentId === 'string') {
    return { kind: 'agent_owner', agentId: row.agentId, approverUserId }
  }
  if (row.kind === 'tenant_admin') return { kind: 'tenant_admin', approverUserId }
  return null
}

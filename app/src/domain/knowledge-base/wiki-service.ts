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
  WikiChangeSetPageSummary,
  WikiChunkRow,
  WikiHistoryRepository,
  WikiPageChangeAction,
  WikiRepository,
} from '@/repositories/interfaces'
import { diffLines } from '@/lib/text-line-diff'
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
  /**
   * #978: a Control Plane-ről indított írás (visszaállítás, GDPR) — szerző a
   * felhasználó, agent-azonosító nem kerül az oldalra / revízióra.
   */
  human?: boolean
}

/** #978: egy visszaállítás cél-állapota (egy korábbi revízióból). */
export type WikiRestoreTarget = {
  path: string
  status: 'published' | 'archived'
  type: WikiPageTypeName
  title: string
  summary: string
  category: string | null
  frontmatter: Record<string, unknown>
  body: string
  sources: WikiSourceRef[]
}

export type WikiLogOpName = 'ingest' | 'query' | 'lint' | 'note' | 'revert'

export type WikiRevertTarget =
  | { kind: 'changeset'; seq: number }
  | { kind: 'page'; path: string; version: number }

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
  /** `restore` csak belső (visszaállítás, #978): az MCP-séma nem engedi. */
  action: 'upsert' | 'patch' | 'archive' | 'move' | 'restore'
  restore?: WikiRestoreTarget
  /** Belső visszaállítás: a státuszváltást / azonos tartalomra újraírást is észleli. */
  expectedPageVersion?: number
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
  /** #978: előzmények (visszaállítás, változáslista, időutazás); hiányában ezek `tool_not_configured`. */
  history?: Pick<
    WikiHistoryRepository,
    | 'findChangeSetBySeq'
    | 'revisionsForChangeSet'
    | 'previousRevision'
    | 'findRevision'
    | 'findPageById'
    | 'listChangeSets'
    | 'latestSeq'
    | 'seqAt'
    | 'stateAt'
    | 'getCursor'
    | 'advanceCursor'
    | 'appliedAtForSeq'
  >
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

  /**
   * A snapshot láthatósága élesítéskor rögzül; utólagos váltás (#965) után az
   * élő connector-sor dönt. Ahol nincs `resolve`, ezzel szűrünk.
   */
  private async liveVisible(caller: WikiCaller, connectorIds: string[]): Promise<string[]> {
    const visible: string[] = []
    for (const connectorId of connectorIds) {
      const row = await this.deps.connectors.findById(connectorId, caller.tenantId)
      if (
        row && row.tenantId === caller.tenantId && row.type === 'knowledge_base' &&
        row.lifecycleState === 'active' && isKnowledgeBaseVisibleTo(row, caller.userId)
      ) visible.push(connectorId)
    }
    return visible
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
      const changes = await this.unseenFor(caller, wiki.id)
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
        // #978 §5.4: csak ha van új módosítás az agent legutóbbi átnézése óta.
        ...(changes ? { changes } : {}),
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

    if (stored.duplicateOf) {
      return { ok: true, result: { ...stored, wikiId: target.wikiId, status: 'duplicate' } }
    }

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
      connectorIds = await this.liveVisible(caller, this.scopes(caller).readable.map((scope) => scope.connectorId))
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
    if ((await this.liveVisible(caller, [input.connectorId])).length === 0) return { ok: false, code: 'not_found' }
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
    /** #978 §5.3: sorszám vagy ISO-dátum — a wiki akkori állapota. */
    asOf?: string | number
  }): Promise<Record<string, unknown> | null> {
    const wiki = input.explicitWiki || input.asOf !== undefined
      ? await this.deps.wikis.findById((await this.wikiIdForConnector(input.tenantId, input.connectorId)) ?? '')
      : await this.deps.wikis.findByConnectorId(input.connectorId)
    if (!wiki) return null
    const path = input.path.trim().replace(/^\/+/, '')
    if (input.asOf !== undefined && String(input.asOf).trim() !== '') {
      return this.readPageAsOf(wiki.id, input.connectorId, path, input.asOf)
    }
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

  private async readPageAsOf(wikiId: string, connectorId: string, path: string, asOf: string | number) {
    const history = this.deps.history
    if (!history) return { found: false, wikiId, path, error: 'history_not_available' }
    const resolved = await this.resolveAsOf(wikiId, asOf)
    if (!resolved) {
      return { found: false, wikiId, path, error: 'invalid_as_of', hint: 'asOf is a change number (e.g. 97) or an ISO date (2026-10-01).' }
    }
    const asOfInfo = { seq: resolved.seq, at: resolved.at?.toISOString() ?? null }
    if (path === WIKI_SCHEMA_PATH || path.toLowerCase() === 'wiki.md') {
      const wiki = await this.deps.wikis.findById(wikiId)
      return { found: true, kind: 'wiki_schema', wikiId, path: WIKI_SCHEMA_PATH, asOf: asOfInfo, note: 'WIKI.md has no history; this is the current version.', text: wiki?.schemaMd ?? '' }
    }
    if (path === WIKI_LOG_PATH) {
      const entries = (await this.deps.wikis.listLog(wikiId, 1000)).filter((entry) => !resolved.at || entry.createdAt <= resolved.at)
      return { found: true, kind: 'wiki_log', wikiId, path, asOf: asOfInfo, text: renderWikiLog(resolved.seq === 0 ? [] : entries) }
    }
    const state = resolved.seq === 0 ? [] : await history.stateAt(wikiId, connectorId, resolved.seq)
    const live = state.filter((row) => row.status !== 'archived' && row.status !== 'pending_approval' && !row.erasedAt)
    if (path === WIKI_INDEX_PATH) {
      const pages = live.map((row) => ({
        path: row.path ?? '',
        title: row.title,
        summary: row.summary,
        category: row.category,
        type: (row.type ?? 'entity') as WikiPageTypeName,
      }))
      return { found: true, kind: 'wiki_index', wikiId, path, asOf: asOfInfo, pageCount: pages.length, text: renderWikiIndex(pages) }
    }
    const row = state.find((candidate) => candidate.path === path)
    if (!row || row.status === 'archived') return { found: false, wikiId, path, asOf: asOfInfo }
    if (row.erasedAt) return { found: false, wikiId, path, asOf: asOfInfo, erased: true, note: 'This version was erased for data-protection reasons.' }
    const pageState: WikiPageState = {
      path,
      type: (row.type ?? 'entity') as WikiPageTypeName,
      title: row.title,
      summary: row.summary,
      category: row.category,
      frontmatter: stripManagedFrontmatter(row.frontmatter),
      body: row.body,
      sources: readWikiSources(row.sourceRefs),
    }
    return {
      found: true,
      kind: 'wiki_page',
      wikiId,
      path,
      asOf: asOfInfo,
      type: pageState.type,
      title: pageState.title,
      summary: pageState.summary,
      category: pageState.category,
      version: row.version,
      versionDate: row.createdAt.toISOString(),
      sources: pageState.sources,
      note: 'Earlier state (read-only). Do not pass this as baseVersion; read the current page before writing.',
      text: renderWikiPageMarkdown(pageState),
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
        op: (stored.op as WikiLogOpName) ?? 'ingest',
        title: stored.title ?? `Updated ${plan.planned.length} pages`,
        note: stored.note ?? null,
      },
      inbox: null,
      revertsId: changeSet.revertsId,
    })
    if (!result.ok) {
      if (result.code === 'conflict' || result.code === 'changeset_not_revertible') {
        await this.reject(changeSetId, { tenantId: caller.tenantId, actorUserId: null, reason: result.code })
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
  // #978 Visszaállítás (D2, D5, D8)

  /**
   * A visszaállítás műveletei a korábbi revíziókból. Change-set: oldalanként az
   * inverz (létrehozott → archiválás, többi → az előző revízió teljes állapota).
   * Bármely érintett oldalt azóta más is írta → `conflict`, oldalanként felsorolva (D8).
   */
  async planRevert(
    connector: Pick<Connector, 'id'>,
    wikiId: string,
    target: WikiRevertTarget,
  ): Promise<
    | { ok: true; pages: WikiPageInput[]; revertsId: string | null; log: { op: 'revert'; title: string; note: string | null }; seq: number | null }
    | WikiFailure
  > {
    const history = this.deps.history
    if (!history) return { ok: false, code: 'tool_not_configured' }
    if (target.kind === 'page') {
      const page = await this.deps.wikis.findPage(connector.id, target.path)
      if (!page || page.wikiId !== wikiId) return { ok: false, code: 'not_found' }
      if (page.version === target.version) return { ok: false, code: 'already_current' }
      const revision = await history.findRevision(connector.id, page.id, target.version)
      if (!revision) return { ok: false, code: 'version_not_found' }
      if (revision.erasedAt) return { ok: false, code: 'version_erased' }
      return {
        ok: true,
        revertsId: null,
        seq: null,
        pages: [{ path: page.path, action: 'restore', baseVersion: page.contentHash, expectedPageVersion: page.version, restore: restoreTarget(revision, page) }],
        log: { op: 'revert', title: `Restored ${page.path} to version ${target.version}`, note: null },
      }
    }
    const changeSet = await history.findChangeSetBySeq(wikiId, target.seq)
    if (!changeSet || changeSet.connectorId !== connector.id) return { ok: false, code: 'not_found' }
    if (changeSet.status !== 'applied') return { ok: false, code: 'changeset_not_revertible', details: { status: changeSet.status } }
    const revisions = await history.revisionsForChangeSet(changeSet.id)
    if (revisions.length === 0) return { ok: false, code: 'nothing_to_revert' }
    const pages: WikiPageInput[] = []
    const conflicts: Array<{ path: string; reason: string }> = []
    for (const revision of revisions) {
      const page = await history.findPageById(connector.id, revision.pageId)
      if (!page) {
        conflicts.push({ path: revision.path ?? revision.title, reason: 'page_missing' })
        continue
      }
      if (page.version !== revision.version) {
        conflicts.push({ path: page.path, reason: 'changed_since' })
        continue
      }
      const previous = await history.previousRevision(connector.id, page.id, revision.version)
      if (!previous) {
        // Ez a change-set hozta létre: visszavonáskor archiválódik.
        pages.push({
          path: page.path,
          action: 'restore',
          expectedPageVersion: page.version,
          baseVersion: page.contentHash,
          restore: { ...restoreTarget(revision, page), path: page.path, status: 'archived' },
        })
        continue
      }
      if (previous.erasedAt) {
        conflicts.push({ path: page.path, reason: 'version_erased' })
        continue
      }
      if (previous.version !== revision.version - 1) {
        conflicts.push({ path: page.path, reason: 'previous_version_pruned' })
        continue
      }
      pages.push({ path: page.path, action: 'restore', baseVersion: page.contentHash, expectedPageVersion: page.version, restore: restoreTarget(previous, page) })
    }
    if (conflicts.length > 0) {
      return {
        ok: false,
        code: 'conflict',
        details: {
          conflicts,
          hint: 'Nothing was reverted. Some pages changed after this change; restore them one by one to an earlier version instead.',
        },
      }
    }
    const title = (changeSet.logEntry as { title?: string } | null)?.title
    return {
      ok: true,
      revertsId: changeSet.id,
      seq: changeSet.seq,
      pages,
      log: { op: 'revert', title: `Reverted #${changeSet.seq}${title ? `: ${title}` : ''}`.slice(0, 200), note: null },
    }
  }

  /**
   * `kb_wiki_revert` (agent): D2 — MINDIG jóváhagyásra vár, a `wikiWriteMode`
   * közvetlen módjától függetlenül. Csak írási jogú wikin.
   */
  async requestRevert(
    caller: WikiCaller,
    input: { wikiId?: string; target: WikiRevertTarget; note?: string },
  ): Promise<WikiWriteOutcome> {
    const resolved = await this.resolve(caller, input.wikiId, 'write')
    if ('ok' in resolved) return resolved
    const { connector, wikiId, scope } = resolved
    const planned = await this.planRevert(connector, wikiId, input.target)
    if (!planned.ok) return planned
    const plan = await this.plan({ connectorId: connector.id, agentId: caller.agentId, pages: planned.pages, sourceDocumentIds: [] })
    if (!plan.ok) return plan
    const approverScope = await this.approverScopeFor(connector)
    const log = { ...planned.log, note: input.note?.trim() || null }
    const pending = await this.deps.wikis.createChangeSet({
      wikiId,
      connectorId: connector.id,
      agentId: caller.agentId,
      userId: caller.userId,
      status: 'pending',
      pages: planned.pages as unknown as Prisma.InputJsonValue,
      validation: { issues: plan.issues } as unknown as Prisma.InputJsonValue,
      logEntry: log as unknown as Prisma.InputJsonValue,
      sourceDocumentIds: [],
      approverScope: approverScope as unknown as Prisma.InputJsonValue,
      revertsId: planned.revertsId,
    })
    await this.audit(connector, caller, 'kb.wiki.changeset.revert_requested', pending.id, {
      wikiId,
      changeSetId: pending.id,
      ...(planned.revertsId ? { revertsId: planned.revertsId, seq: planned.seq } : {}),
      pageCount: planned.pages.length,
      kind: input.target.kind,
    })
    const shared = scope.visibility !== 'private_to_user'
    const pageList = planned.pages.map((page) => ({ path: page.path, action: 'restore' }))
    return {
      ok: 'approval',
      request: {
        changeSetId: pending.id,
        wikiId,
        connectorId: connector.id,
        pageCount: planned.pages.length,
        ...(shared ? { pages: pageList } : {}),
        applied: null,
        reason: 'approval_mode',
      },
      result: {
        wikiId,
        changeSetId: pending.id,
        pendingPages: pageList,
        note: 'Reverting always needs approval: nothing changes until the wiki approver accepts it.',
      },
    }
  }

  /**
   * Konzolról (jóváhagyó / admin / privátnál a tulajdonos — a jogot a hívó
   * ellenőrizte): azonnal alkalmazódik, új change-setként (D5).
   */
  async revertAsHuman(input: {
    tenantId: string
    userId: string
    connector: Connector
    wikiId: string
    target: WikiRevertTarget
  }): Promise<WikiOutcome<WikiAppliedSummary & { seq: number }>> {
    const planned = await this.planRevert(input.connector, input.wikiId, input.target)
    if (!planned.ok) return planned
    const caller: WikiCaller = {
      tenantId: input.tenantId,
      userId: input.userId,
      agentId: input.userId,
      snapshot: { connectors: [] },
      human: true,
    }
    const plan = await this.plan({ connectorId: input.connector.id, agentId: '', pages: planned.pages, sourceDocumentIds: [] })
    if (!plan.ok) return plan
    const approverScope = await this.approverScopeFor(input.connector)
    return this.apply({
      caller,
      connector: input.connector,
      wikiId: input.wikiId,
      planned: plan.planned,
      changeSet: {
        create: {
          wikiId: input.wikiId,
          connectorId: input.connector.id,
          agentId: null,
          userId: input.userId,
          pages: planned.pages as unknown as Prisma.InputJsonValue,
          validation: { issues: plan.issues } as unknown as Prisma.InputJsonValue,
          logEntry: planned.log as unknown as Prisma.InputJsonValue,
          sourceDocumentIds: [],
          approverScope: approverScope as unknown as Prisma.InputJsonValue,
          revertsId: planned.revertsId,
        },
      },
      log: planned.log,
      inbox: null,
      revertsId: planned.revertsId,
    })
  }

  // -------------------------------------------------------------------------
  // #978 §5.4 Agent-változáslista (D4: összefoglaló, diff nélkül)

  async changes(
    caller: WikiCaller,
    input: { wikiId?: string; since?: number | 'last_seen'; limit?: number; markSeen?: boolean },
  ): Promise<WikiOutcome> {
    const history = this.deps.history
    if (!history) return { ok: false, code: 'tool_not_configured' }
    const target = await this.resolve(caller, input.wikiId, 'read')
    if ('ok' in target) return target
    const { wikiId } = target
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50)
    const latestSeq = await history.latestSeq(wikiId)
    const cursor = await history.getCursor(wikiId, caller.agentId, caller.userId)
    const since = typeof input.since === 'number' ? Math.max(0, Math.floor(input.since)) : cursor
    const rows =
      since === null
        ? (await history.listChangeSets(wikiId, { limit: 10, order: 'desc' })).reverse()
        : await history.listChangeSets(wikiId, { afterSeq: since, limit: limit + 1, order: 'asc' })
    const truncated = since !== null && rows.length > limit
    const changes = truncated ? rows.slice(0, limit) : rows
    const agentNames = await this.agentNames(caller.tenantId, changes.map((row) => row.agentId))
    const userLabels = new Map<string, string | null>()
    for (const userId of new Set(changes.filter((row) => !row.agentId && row.userId).map((row) => row.userId!))) {
      userLabels.set(userId, (await this.deps.findUserLabel?.(userId)) ?? null)
    }
    const revertedSeqs = new Map<string, number | null>()
    for (const row of changes) {
      if (row.revertsId && !revertedSeqs.has(row.revertsId)) {
        revertedSeqs.set(row.revertsId, (await this.deps.wikis.findChangeSet(row.revertsId))?.seq ?? null)
      }
    }
    const maxSeq = changes.reduce((max, row) => Math.max(max, row.seq ?? 0), since ?? 0)
    if (input.markSeen !== false && changes.length > 0) {
      await history.advanceCursor(wikiId, caller.agentId, caller.userId, maxSeq)
    }
    return {
      ok: true,
      result: {
        wikiId,
        latestSeq,
        sinceSeq: since,
        truncated,
        changes: changes.map((row) => {
          const log = (row.logEntry ?? {}) as { op?: string; title?: string; note?: string | null }
          return {
            seq: row.seq,
            appliedAt: row.appliedAt?.toISOString() ?? null,
            author: row.agentId
              ? { kind: 'agent', name: agentNames.get(row.agentId) ?? null }
              : { kind: 'user', name: row.userId ? userLabels.get(row.userId) ?? null : null },
            op: log.op ?? null,
            title: log.title ?? null,
            ...(log.note ? { note: log.note } : {}),
            ...(row.revertsId ? { reverts: revertedSeqs.get(row.revertsId) ?? null } : {}),
            ...(row.status === 'reverted' ? { reverted: true } : {}),
            pages: readPageSummary(row.pageSummary).slice(0, 50).map((page) => ({
              path: page.path,
              action: page.action,
              title: page.title,
              linesAdded: page.linesAdded,
              linesRemoved: page.linesRemoved,
              ...(page.fromPath ? { fromPath: page.fromPath } : {}),
            })),
          }
        }),
        nextStep:
          changes.length === 0
            ? 'No new changes since you last looked.'
            : truncated
              ? 'More changes are waiting: call kb_wiki_changes again. Read a page with kb_get_page when you need the details.'
              : 'Read a page with kb_get_page when you need the details (asOf shows an earlier state).',
      },
    }
  }

  /** Briefing-jelzés (§5.4): hány alkalmazott change-set van az agent cursora után. */
  private async unseenFor(caller: WikiCaller, wikiId: string): Promise<{ latestSeq: number; unseen: number } | null> {
    const history = this.deps.history
    if (!history) return null
    const latestSeq = await history.latestSeq(wikiId)
    if (latestSeq === 0) return null
    const cursor = await history.getCursor(wikiId, caller.agentId, caller.userId)
    const unseen = cursor === null ? Math.min(latestSeq, 10) : Math.max(latestSeq - cursor, 0)
    return unseen > 0 ? { latestSeq, unseen } : null
  }

  /**
   * #978 §5.3: `asOf` (sorszám vagy ISO-dátum) → sorszám; a jövő / ismeretlen
   * a legutóbbi állapotot adja. `null` = érvénytelen bemenet.
   */
  async resolveAsOf(wikiId: string, asOf: string | number): Promise<{ seq: number; at: Date | null } | null> {
    const history = this.deps.history
    if (!history) return null
    const latest = await history.latestSeq(wikiId)
    if (typeof asOf === 'number' || /^\d+$/.test(String(asOf).trim())) {
      const seq = Math.min(Math.max(Number(asOf), 0), latest)
      return { seq, at: seq > 0 ? await history.appliedAtForSeq(wikiId, seq) : null }
    }
    const text = String(asOf).trim()
    // Csak dátum → a nap vége (UTC), hogy „október 1-jén” az aznapi változásokat is mutassa.
    const at = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T23:59:59.999Z` : text)
    if (Number.isNaN(at.getTime())) return null
    return { seq: await history.seqAt(wikiId, at), at }
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
      const finalPath =
        page.action === 'move' ? page.newPath?.trim() ?? '' : page.action === 'restore' ? page.restore?.path ?? path : path
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

      if (page.action === 'restore') {
        // #978: belső visszaállítás egy korábbi revízió teljes állapotára.
        const target = page.restore
        if (!existing || !target) {
          error(path, 'page_not_found', `No page at ${path}.`)
          continue
        }
        // D8: csak a várt állapoton fut — ha azóta más is írta, ütközés (semmi nem íródik).
        if (page.baseVersion !== existing.contentHash || page.expectedPageVersion !== existing.version) {
          conflicts.push(conflictPayload(existing, 'the page changed after the version you restore'))
          continue
        }
        // GDPR: a függő change-set a törlés előtt fagyasztotta be a tartalmat —
        // sír-jeles hash-re ne írjuk vissza (applyApproved újra plan-el).
        const restoreState: WikiPageState = {
          path: target.path,
          type: target.type,
          title: target.title,
          summary: target.summary,
          category: target.category,
          frontmatter: stripManagedFrontmatter(target.frontmatter),
          body: target.body,
          sources: target.sources,
        }
        const restoreHash = wikiPageContentHash(restoreState)
        const revisions = await this.deps.wikis.listRevisions(existing.id)
        if (revisions.some((rev) => rev.erasedAt && rev.contentHash === restoreHash)) {
          error(path, 'version_erased', 'That version was erased for data-protection reasons and cannot be restored.')
          continue
        }
        if (target.path !== existing.path) {
          if (!isValidWikiPath(target.path) || isReservedWikiPath(target.path)) {
            error(path, 'invalid_path', 'The restored path is not a valid wiki path.')
            continue
          }
          const taken = await this.deps.wikis.findPage(input.connectorId, target.path)
          if (taken && taken.id !== existing.id) {
            error(path, 'path_taken', `A page already exists at ${target.path}.`)
            continue
          }
        }
        pathsAfterWrite.delete(existing.path)
        if (target.status === 'published') pathsAfterWrite.add(target.path)
        planned.push({
          input: page,
          existing,
          state: restoreState,
          status: target.status,
          othersPage: false,
        })
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
        // Visszaállításnál a korábban elfogadott tartalmat nem validáljuk újra, csak a path-t.
        action:
          page.input.action === 'restore' || (page.status === 'archived' && page.input.action !== 'patch')
            ? 'archive'
            : page.input.action,
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
    log: { op: WikiLogOpName; title: string; note: string | null }
    inbox: Parameters<WikiRepository['applyChangeSet']>[0]['inbox']
    /** #978 D5: a visszavont change-set (audithoz; a repó a change-set sorából is tudja). */
    revertsId?: string | null
  }): Promise<WikiOutcome<WikiAppliedSummary & { seq: number }>> {
    const { caller, connector } = input
    const agentId = caller.human ? null : caller.agentId
    const ops: WikiApplyPageOp[] = input.planned.map((page) => {
      const write = toPageWrite(page)
      const chunks = page.status === 'archived' ? [] : pageChunks(page.state)
      if (!page.existing) {
        return {
          kind: 'create',
          page: write,
          createdByAgentId: agentId,
          createdByUserId: caller.human ? caller.userId : null,
          chunks,
        }
      }
      return {
        kind: 'update',
        pageId: page.existing.id,
        expectedVersion: page.existing.version,
        previousPath: page.existing.path,
        page: write,
        updatedByAgentId: agentId,
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
        actorAgentId: agentId,
        actorUserId: caller.userId,
      },
      inbox: input.inbox,
      pageSummary: input.planned.map(summarizePlannedPage),
      appliedAt: this.now(),
    })
    if (!result.ok) {
      if (result.reason === 'changeset_not_pending') return { ok: false, code: 'changeset_not_pending' }
      if (result.reason === 'changeset_not_revertible') return { ok: false, code: 'changeset_not_revertible' }
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
      seq: result.seq,
      pageCount: result.pages.length,
    })
    if (input.revertsId) {
      await this.audit(connector, caller, 'kb.wiki.changeset.reverted', input.revertsId, {
        wikiId: input.wikiId,
        changeSetId: input.revertsId,
        revertedById: result.changeSetId,
        seq: result.seq,
      })
    }
    for (const [i, page] of result.pages.entries()) {
      const planned = input.planned[i]
      await this.audit(
        connector,
        caller,
        planned.input.action === 'restore'
          ? 'kb.wiki.page.restored'
          : !planned.existing
            ? 'kb.wiki.page.created'
            : page.status === 'archived'
              ? 'kb.wiki.page.archived'
              : 'kb.wiki.page.updated',
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
        seq: result.seq,
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
        actorType: caller.human ? 'human' : 'agent',
        actorId: caller.human ? caller.userId : caller.agentId,
        agentVersion: null,
        action,
        targetType,
        targetId,
        modelUsed: null,
        inputRef: null,
        outputRef: connector.id,
        policyDecision: 'allowed',
        metadata: {
          ...metadata,
          ...(caller.human ? {} : { agentId: caller.agentId }),
          userId: caller.userId,
          connectorId: connector.id,
        },
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

/** #978 §6: az alkalmazáskor rögzített oldal-összefoglaló (diff nélkül). */
function summarizePlannedPage(page: PlannedPage): Omit<WikiChangeSetPageSummary, 'pageId' | 'version'> {
  const before = page.existing
  const action: WikiPageChangeAction = !before
    ? 'created'
    : page.status === 'archived' && before.status !== 'archived'
      ? 'archived'
      : page.status === 'published' && before.status === 'archived'
        ? 'restored'
        : page.state.path !== before.path
          ? 'moved'
          : 'updated'
  const rows = action === 'archived' ? [] : diffLines(before?.body ?? '', page.state.body)
  return {
    path: page.state.path,
    ...(before && before.path !== page.state.path ? { fromPath: before.path } : {}),
    action,
    title: page.state.title,
    linesAdded: rows.filter((row) => row.kind === 'add').length,
    linesRemoved: rows.filter((row) => row.kind === 'del').length,
  }
}

export function pageChunks(state: WikiPageState): WikiChunkRow[] {
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

function restoreTarget(
  revision: {
    path: string | null
    status: string | null
    type: string | null
    category: string | null
    title: string
    summary: string
    frontmatter: unknown
    body: string
    sourceRefs: unknown
  },
  page: WikiPage,
): WikiRestoreTarget {
  // A bevezetés előtti (backfill) revízióknál hiányzó mezők az oldal mostani értékét kapják.
  const legacy = revision.type === null
  return {
    path: revision.path ?? page.path,
    status: revision.status === 'archived' ? 'archived' : 'published',
    type: (revision.type ?? page.type) as WikiPageTypeName,
    title: revision.title,
    summary: revision.summary,
    category: legacy ? page.category : revision.category,
    frontmatter: stripManagedFrontmatter(revision.frontmatter),
    body: revision.body,
    sources: readWikiSources(revision.sourceRefs ?? page.sourceRefs),
  }
}

export function readPageSummary(value: unknown): WikiChangeSetPageSummary[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (row): row is WikiChangeSetPageSummary =>
      !!row && typeof row === 'object' && typeof (row as { path?: unknown }).path === 'string',
  )
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

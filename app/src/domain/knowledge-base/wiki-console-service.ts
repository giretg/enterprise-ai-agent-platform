/**
 * #946 LLM Wiki 5/6 — a Control Plane wiki-nézete (#941 §8, §9).
 *
 * Minden jogosultsági döntés itt van, nem a UI-ban: a server actionök és az
 * export-route csak ezt hívják. Szabályok (D13/D14):
 * - privát tudásbázis tartalmát csak a tulajdonos látja; a tenant admin a
 *   listában egy tartalommentes metaadat-sort lát, minden más hívás `not_found`;
 * - közös tudásbázist operátor olvas és tölthet fel a tálcára, admin kezel
 *   (kihagyás, agent-jogok);
 * - a jóváhagyó kártya részleteit csak a change-set döntéshozója kapja meg.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Connector, MemoryWriteMode, WikiAccess, WikiPage } from '@prisma/client'
import type { AgentRepository, AuditRepository, ConnectorRepository, DocumentRepository, WikiRepository } from '@/repositories/interfaces'
import type { WikiConsoleRepository } from '@/repositories/postgres/wiki-console-repository'
import { hasMinimumRole } from '@/auth/types'
import { isPrivilegedAgentReader } from '@/domain/agent-definition'
import type { UserRole } from '@prisma/client'
import { redactKbAuditForVisibility } from '@/lib/audit/kb-private-redaction'
import { buildStoredZip, type ZipWriteEntry } from '@/lib/skill/zip-writer'
import { diffLines, type LineDiffRow } from '@/lib/text-line-diff'
import {
  WIKI_INDEX_PATH,
  WIKI_LOG_PATH,
  WIKI_SCHEMA_PATH,
  defaultWikiSchema,
  groupWikiIndex,
  readWikiSources,
  renderWikiIndex,
  renderWikiLog,
  renderWikiPageMarkdown,
  stripManagedFrontmatter,
  type WikiSourceRef,
} from '@/lib/kb-wiki'
import { isKbLanguage, type KbLanguage } from '@/lib/kb-language'
import {
  KB_CATALOG_CONNECTOR_NAME,
  canManageKnowledgeBaseLink,
  effectiveWikiAccess,
  effectiveWikiWriteMode,
  isPrivateKnowledgeBase,
  ownerAgentIdForKnowledgeBase,
  type WikiDecider,
} from '@/lib/wiki-access'
import { KB_MAX_FILE_BYTES, type KnowledgeBaseService } from './knowledge-base-service'
import { privateKnowledgeBaseDisplayName, type WikiAccessService } from './wiki-access-service'
import type { WikiService } from './wiki-service'

export const WIKI_TEMPLATE_IDS = ['general', 'health-journal'] as const
export type WikiTemplateChoice = (typeof WIKI_TEMPLATE_IDS)[number]
/** A WIKI.md szabályfájl felső mérete (a sablonok ~3 KB-osak). */
export const MAX_WIKI_SCHEMA_CHARS = 20_000
/** D17: ennyi után a váró tétel kiemelt a wiki gazdájának. */
export const WIKI_INBOX_STALE_MS = 3 * 24 * 60 * 60 * 1000
const MAX_KB_NAME = 120

export type WikiConsoleActor = { userId: string; tenantId: string; role: UserRole | string; assumed?: boolean }

export class WikiConsoleError extends Error {
  constructor(readonly code: 'not_found' | 'forbidden' | 'invalid_args' | 'too_large') {
    super(code)
    this.name = 'WikiConsoleError'
  }
}

export type WikiKbKind = 'catalog' | 'agent' | 'shared' | 'private'

type Access = { view: boolean; contribute: boolean; manage: boolean; metaOnly: boolean }

export type WikiConsoleDeps = {
  documents: Pick<DocumentRepository, 'readSource'>
  connectors: Pick<ConnectorRepository, 'findById' | 'create' | 'updateKnowledgeBase'>
  agents: Pick<AgentRepository, 'findById' | 'findConnectorsForAgent' | 'findConnectorBinding'>
  wikis: Pick<
    WikiRepository,
    | 'findByConnectorId'
    | 'listPages'
    | 'findPage'
    | 'listRevisions'
    | 'listLog'
    | 'inboxSummary'
    | 'skipInboxItem'
    | 'submitToInbox'
    | 'findDocumentByContentHash'
    | 'listPendingChangeSetIds'
    | 'updateSchema'
  >
  console: WikiConsoleRepository
  wiki: Pick<WikiService, 'wikiIdForConnector' | 'previewChangeSet' | 'canDecide' | 'reject'>
  wikiAccess: Pick<WikiAccessService, 'createPrivateKnowledgeBase' | 'linkKnowledgeBase' | 'setWikiAccess' | 'purgePrivateKnowledgeBase'>
  knowledgeBase: Pick<KnowledgeBaseService, 'ingestIntoKnowledgeBase'>
  audit: Pick<AuditRepository, 'append'>
  now?: () => Date
}

function role(actor: WikiConsoleActor): UserRole {
  return actor.role as UserRole
}

function accessFor(actor: WikiConsoleActor, connector: Pick<Connector, 'visibility' | 'ownerUserId'>): Access {
  if (isPrivateKnowledgeBase(connector)) {
    const owner = !!connector.ownerUserId && connector.ownerUserId === actor.userId
    return {
      view: owner,
      contribute: owner,
      manage: owner,
      metaOnly: !owner && hasMinimumRole(role(actor), 'admin'),
    }
  }
  if (connector.visibility !== 'shared') return { view: false, contribute: false, manage: false, metaOnly: false }
  const operator = hasMinimumRole(role(actor), 'operator')
  const admin = hasMinimumRole(role(actor), 'admin')
  return { view: operator, contribute: operator, manage: admin, metaOnly: false }
}

export function wikiKbKind(connector: Pick<Connector, 'name' | 'visibility'>): WikiKbKind {
  if (isPrivateKnowledgeBase(connector)) return 'private'
  if (connector.name === KB_CATALOG_CONNECTOR_NAME) return 'catalog'
  if (ownerAgentIdForKnowledgeBase(connector.name)) return 'agent'
  return 'shared'
}

function author(page: Pick<WikiPage, 'createdByAgentId' | 'createdByUserId'>, agents: Map<string, string>, users: Map<string, string>) {
  if (page.createdByUserId) return { kind: 'human' as const, name: users.get(page.createdByUserId) ?? null }
  if (page.createdByAgentId) return { kind: 'agent' as const, name: agents.get(page.createdByAgentId) ?? null }
  return null
}

function safeFilePart(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'source'
}

export class WikiConsoleService {
  constructor(private readonly deps: WikiConsoleDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date()
  }

  /** A connector csak akkor „létezik” a hívónak, ha legalább metaadatot láthat. */
  private async load(actor: WikiConsoleActor, connectorId: string, need: 'view' | 'contribute' | 'manage') {
    const connector = await this.deps.connectors.findById(connectorId, actor.tenantId)
    if (!connector || connector.tenantId !== actor.tenantId || connector.type !== 'knowledge_base') {
      throw new WikiConsoleError('not_found')
    }
    const access = accessFor(actor, connector)
    if (!access.view) throw new WikiConsoleError('not_found')
    if (!access[need]) throw new WikiConsoleError('forbidden')
    return { connector, access }
  }

  private async displayName(connector: Connector): Promise<string> {
    const kind = wikiKbKind(connector)
    if (kind === 'private') return privateKnowledgeBaseDisplayName(connector) ?? 'Private knowledge base'
    if (kind === 'catalog') return 'Company knowledge base'
    if (kind === 'agent') {
      const agentId = ownerAgentIdForKnowledgeBase(connector.name)!
      const agent = await this.deps.agents.findById(agentId, connector.tenantId)
      return agent?.name ?? 'Agent knowledge base'
    }
    const config = connector.config && typeof connector.config === 'object' && !Array.isArray(connector.config)
      ? (connector.config as Record<string, unknown>)
      : {}
    return typeof config.displayName === 'string' && config.displayName.trim() ? config.displayName.trim() : connector.name
  }

  // -------------------------------------------------------------------------
  // Lista + létrehozás

  async listKnowledgeBases(actor: WikiConsoleActor) {
    const rows = await this.deps.console.listKnowledgeBases(actor.tenantId)
    const visible = rows.filter((row) => {
      const access = accessFor(actor, row)
      return access.view || access.metaOnly
    })
    const summary = await this.deps.wikis.inboxSummary(
      visible.filter((row) => accessFor(actor, row).view).map((row) => row.connectorId),
      { now: this.now() },
    )
    const agentIds = visible.map((row) => ownerAgentIdForKnowledgeBase(row.name)).filter((id): id is string => !!id)
    const agentNames = await this.deps.console.agentNames(actor.tenantId, agentIds)
    return visible.map((row) => {
      const access = accessFor(actor, row)
      const kind = wikiKbKind(row)
      const stats = { sourceCount: row.sourceCount, pageCount: row.pageCount, bytes: row.bytes }
      if (!access.view) {
        // D13 admin-nézet: név, tartalom, tálca nélkül.
        return { connectorId: row.connectorId, kind, metadataOnly: true as const, ownerLabel: row.ownerLabel, ...stats }
      }
      const counts = summary.wikis.find((item) => item.connectorId === row.connectorId)
      const agentId = ownerAgentIdForKnowledgeBase(row.name)
      const name =
        kind === 'private'
          ? privateKnowledgeBaseDisplayName({ config: row.config }) ?? 'Private knowledge base'
          : kind === 'catalog'
            ? 'Company knowledge base'
            : kind === 'agent'
              ? agentNames.get(agentId!) ?? 'Agent knowledge base'
              : configDisplayName(row.config) ?? row.name
      return {
        connectorId: row.connectorId,
        kind,
        metadataOnly: false as const,
        name,
        ownerLabel: kind === 'private' ? row.ownerLabel : null,
        template: configTemplate(row.config),
        canManage: access.manage,
        inbox: { pending: counts?.pending ?? 0, inProgress: counts?.inProgress ?? 0 },
        ...stats,
      }
    })
  }

  async createKnowledgeBase(
    actor: WikiConsoleActor,
    input: { displayName: string; private: boolean; template?: string; kbLanguage?: string },
  ): Promise<{ connectorId: string }> {
    const displayName = input.displayName.trim().slice(0, MAX_KB_NAME)
    if (!displayName) throw new WikiConsoleError('invalid_args')
    const template = (WIKI_TEMPLATE_IDS as readonly string[]).includes(input.template ?? '')
      ? (input.template as WikiTemplateChoice)
      : 'general'
    const kbLanguage: KbLanguage | undefined = isKbLanguage(input.kbLanguage) ? input.kbLanguage : undefined
    if (input.private) {
      const connector = await this.deps.wikiAccess.createPrivateKnowledgeBase({
        actor: { userId: actor.userId, tenantId: actor.tenantId, role: String(actor.role) },
        displayName,
        kbLanguage,
        wikiTemplate: template,
      })
      return { connectorId: connector.id }
    }
    if (!hasMinimumRole(role(actor), 'admin')) throw new WikiConsoleError('forbidden')
    // A connector-név egyedi (tenant + típus); a megjelenített név a configban él.
    const name = `kb:shared:${randomUUID()}`
    const connector = await this.deps.connectors.create({
      tenantId: actor.tenantId,
      type: 'knowledge_base',
      name,
      authMode: 'agent_owned',
      scope: 'single',
      config: { displayName, wikiTemplate: template },
      visibility: 'shared',
    })
    await this.deps.audit.append({
      actorType: 'human',
      actorId: actor.userId,
      agentVersion: null,
      action: 'kb.created',
      targetType: 'connector',
      targetId: connector.id,
      modelUsed: null,
      inputRef: displayName,
      outputRef: connector.id,
      policyDecision: 'allowed',
      metadata: { connectorId: connector.id, template },
      tenantId: actor.tenantId,
    })
    return { connectorId: connector.id }
  }

  // -------------------------------------------------------------------------
  // Wiki fül

  async getOverview(actor: WikiConsoleActor, connectorId: string) {
    const { connector, access } = await this.load(actor, connectorId, 'view')
    const wikiId = await this.deps.wiki.wikiIdForConnector(actor.tenantId, connector.id)
    const [pages, log, bindings, summary] = await Promise.all([
      this.deps.wikis.listPages(connector.id, { status: 'published' }),
      wikiId ? this.deps.wikis.listLog(wikiId, 300) : Promise.resolve([]),
      this.deps.console.listBindingsForConnector(connector.id),
      this.deps.wikis.inboxSummary([connector.id], { now: this.now() }),
    ])
    const agentNames = await this.deps.console.agentNames(actor.tenantId, [
      ...pages.flatMap((page) => [page.createdByAgentId, page.updatedByAgentId]).filter((id): id is string => !!id),
      ...log.map((entry) => entry.actorAgentId).filter((id): id is string => !!id),
    ])
    const users = await this.deps.console.userLabels([
      ...pages.map((page) => page.createdByUserId).filter((id): id is string => !!id),
      ...log.map((entry) => entry.actorUserId).filter((id): id is string => !!id),
    ])
    const counts = summary.wikis[0]
    return {
      connectorId: connector.id,
      wikiId,
      kind: wikiKbKind(connector),
      name: await this.displayName(connector),
      private: isPrivateKnowledgeBase(connector),
      template: configTemplate(connector.config),
      canManage: access.manage,
      canContribute: access.contribute,
      pageCount: pages.length,
      categories: groupWikiIndex(pages).map((group) => ({
        category: group.category,
        pages: group.pages.map((indexPage) => {
          const page = pages.find((row) => row.path === indexPage.path)!
          return {
            path: page.path,
            title: page.title,
            summary: page.summary,
            type: page.type,
            updatedAt: page.updatedAt.toISOString(),
            author: author(page, agentNames, users),
          }
        }),
      })),
      log: [...log].reverse().map((entry) => ({
        id: entry.id,
        op: entry.op,
        title: entry.title,
        note: entry.note,
        pagePaths: entry.pagePaths,
        createdAt: entry.createdAt.toISOString(),
        actor: entry.actorAgentId
          ? { kind: 'agent' as const, name: agentNames.get(entry.actorAgentId) ?? null }
          : entry.actorUserId
            ? { kind: 'human' as const, name: users.get(entry.actorUserId) ?? null }
            : null,
      })),
      access: bindings.map((row) => ({
        agentId: row.agentId,
        agentName: row.agentName,
        access: effectiveWikiAccess(row),
        writeMode: effectiveWikiWriteMode(row),
        collectFocus: row.wikiCollectFocus,
      })),
      inbox: {
        pending: counts?.pending ?? 0,
        inProgress: counts?.inProgress ?? 0,
        processed: counts?.processed ?? 0,
        skipped: counts?.skipped ?? 0,
      },
    }
  }

  async getPage(actor: WikiConsoleActor, connectorId: string, path: string) {
    const { connector } = await this.load(actor, connectorId, 'view')
    const page = await this.deps.wikis.findPage(connector.id, path.trim())
    if (!page || page.status === 'pending_approval') throw new WikiConsoleError('not_found')
    const [revisions, published] = await Promise.all([
      this.deps.wikis.listRevisions(page.id),
      this.deps.wikis.listPages(connector.id, { status: 'published' }),
    ])
    const sources = readWikiSources(page.sourceRefs)
    const documents = await this.deps.console.listSourceDocuments(
      connector.id,
      [...new Set(sources.map((ref) => ref.documentId))].filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
    )
    const agentNames = await this.deps.console.agentNames(
      actor.tenantId,
      [page.createdByAgentId, page.updatedByAgentId].filter((id): id is string => !!id),
    )
    const users = await this.deps.console.userLabels(page.createdByUserId ? [page.createdByUserId] : [])
    return {
      path: page.path,
      title: page.title,
      summary: page.summary,
      category: page.category,
      type: page.type,
      status: page.status,
      version: page.version,
      body: page.body,
      frontmatter: stripManagedFrontmatter(page.frontmatter),
      updatedAt: page.updatedAt.toISOString(),
      createdAt: page.createdAt.toISOString(),
      author: author(page, agentNames, users),
      lastEditor: page.updatedByAgentId ? agentNames.get(page.updatedByAgentId) ?? null : null,
      sources: sources.map((ref) => ({
        ...ref,
        filename: documents.find((doc) => doc.id === ref.documentId)?.filename ?? ref.filename ?? null,
        exists: documents.some((doc) => doc.id === ref.documentId),
      })),
      knownPaths: published.map((row) => row.path),
      revisions: [...revisions]
        .sort((a, b) => b.version - a.version)
        .map((rev) => ({ version: rev.version, title: rev.title, createdAt: rev.createdAt.toISOString(), current: rev.version === page.version })),
    }
  }

  /** Nyers forrás olvasása (forrás-hivatkozás célja). */
  async getSource(actor: WikiConsoleActor, connectorId: string, documentId: string) {
    const { connector } = await this.load(actor, connectorId, 'view')
    const doc = await this.deps.console.findSourceDocument(connector.id, documentId)
    if (!doc) throw new WikiConsoleError('not_found')
    return { documentId: doc.id, filename: doc.filename, text: doc.extractedText ?? '', createdAt: doc.createdAt.toISOString() }
  }

  // -------------------------------------------------------------------------
  // Tálca

  async listInbox(actor: WikiConsoleActor, connectorId: string) {
    const { connector, access } = await this.load(actor, connectorId, 'view')
    const now = this.now()
    const [items, summary] = await Promise.all([
      this.deps.console.listInboxItems(connector.id, { now }),
      this.deps.wikis.inboxSummary([connector.id], { now }),
    ])
    const agentNames = await this.deps.console.agentNames(
      actor.tenantId,
      items.flatMap((item) => [item.claimedByAgentId, item.submittedByAgentId]).filter((id): id is string => !!id),
    )
    const totals = summary.wikis[0]
    return {
      canManage: access.manage,
      canContribute: access.contribute,
      totals: {
        pending: totals?.pending ?? 0,
        inProgress: totals?.inProgress ?? 0,
        processed: totals?.processed ?? 0,
        skipped: totals?.skipped ?? 0,
      },
      batches: summary.batches.map(({ batchId, pending, inProgress, processed, skipped }) => {
        const first = items.find((item) => item.batchId === batchId)
        return {
          batchId,
          pending,
          inProgress,
          processed,
          skipped,
          total: pending + inProgress + processed + skipped,
          createdAt: first?.createdAt.toISOString() ?? null,
        }
      }).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
      items: items.map((item) => ({
        documentId: item.documentId,
        filename: item.filename,
        purpose: item.purpose,
        status: item.status,
        submittedBy: item.submittedByAgentId
          ? { kind: 'agent' as const, name: agentNames.get(item.submittedByAgentId) ?? null }
          : { kind: 'human' as const, name: item.uploadedByLabel },
        claimedBy: item.claimedByAgentId ? agentNames.get(item.claimedByAgentId) ?? null : null,
        submittedAt: item.createdAt.toISOString(),
        batchId: item.batchId,
        // D17: csak a gazdának emeljük ki.
        stale:
          access.manage &&
          item.status === 'pending' &&
          now.getTime() - item.createdAt.getTime() > WIKI_INBOX_STALE_MS,
      })),
    }
  }

  /** Egy fájl a köteg-feltöltésből (a kliens fájlonként hív, közös `batchId`-vel). */
  async uploadToInbox(
    actor: WikiConsoleActor,
    input: {
      connectorId: string
      batchId: string
      batchSeq: number
      filename: string
      mimeType?: string | null
      buffer: Buffer
      purpose?: string | null
    },
  ): Promise<{ status: 'queued'; documentId: string } | { status: 'duplicate'; existingDocumentId: string }> {
    const { connector } = await this.load(actor, input.connectorId, 'contribute')
    if (!/^[0-9a-f-]{36}$/i.test(input.batchId) || !Number.isInteger(input.batchSeq) || input.batchSeq < 0) {
      throw new WikiConsoleError('invalid_args')
    }
    if (input.buffer.byteLength === 0) throw new WikiConsoleError('invalid_args')
    if (input.buffer.byteLength > KB_MAX_FILE_BYTES) throw new WikiConsoleError('too_large')
    const contentHash = createHash('sha256').update(input.buffer).digest('hex')
    const existing = await this.deps.wikis.findDocumentByContentHash(connector.id, contentHash)
    if (existing) return { status: 'duplicate', existingDocumentId: existing.id }
    const stored = await this.deps.knowledgeBase.ingestIntoKnowledgeBase({
      tenantId: actor.tenantId,
      connectorId: connector.id,
      uploadedById: actor.userId,
      filename: input.filename,
      mimeType: input.mimeType ?? null,
      buffer: input.buffer,
      purpose: input.purpose ?? null,
    })
    if (stored.duplicateOf) return { status: 'duplicate', existingDocumentId: stored.documentId }
    await this.deps.wikis.submitToInbox({
      documentId: stored.documentId,
      status: 'pending',
      submittedByAgentId: null,
      batchId: input.batchId,
      batchSeq: input.batchSeq,
    })
    await this.audit(connector, actor, 'kb.wiki.inbox.submitted', stored.documentId, 'document', {
      documentId: stored.documentId,
      batchId: input.batchId,
      status: 'pending',
      kind: 'file',
    })
    return { status: 'queued', documentId: stored.documentId }
  }

  async skipInboxItem(actor: WikiConsoleActor, connectorId: string, documentId: string) {
    const { connector } = await this.load(actor, connectorId, 'manage')
    const skipped = await this.deps.wikis.skipInboxItem({ documentId, connectorId: connector.id })
    if (!skipped) throw new WikiConsoleError('not_found')
    await this.audit(connector, actor, 'kb.wiki.inbox.skipped', documentId, 'document', { documentId })
    return { skipped: true }
  }

  // -------------------------------------------------------------------------
  // Export + végleges törlés

  async exportZip(actor: WikiConsoleActor, connectorId: string): Promise<{ filename: string; bytes: Uint8Array }> {
    const { connector } = await this.load(actor, connectorId, 'manage')
    const wikiId = await this.deps.wiki.wikiIdForConnector(actor.tenantId, connector.id)
    const [pages, documents] = await Promise.all([
      this.deps.wikis.listPages(connector.id, { status: ['published', 'archived'] }),
      this.deps.console.listSourceDocuments(connector.id),
    ])
    const name = await this.displayName(connector)
    const root = safeFilePart(name)
    const encoder = new TextEncoder()
    const entries: ZipWriteEntry[] = []
    const add = (path: string, text: string) => entries.push({ path: `${root}/${path}`, bytes: encoder.encode(text) })
    const published = pages.filter((page) => page.status === 'published')
    add(WIKI_INDEX_PATH, renderWikiIndex(published))
    if (wikiId) {
      add(WIKI_LOG_PATH, renderWikiLog(await this.deps.wikis.listLog(wikiId, 1000)))
    }
    for (const page of pages) {
      const markdown = renderWikiPageMarkdown({
        type: page.type,
        title: page.title,
        summary: page.summary,
        category: page.category,
        frontmatter: stripManagedFrontmatter(page.frontmatter),
        body: page.body,
        sources: readWikiSources(page.sourceRefs),
      })
      add(page.status === 'archived' ? `_archived/${page.path}` : page.path, markdown)
    }
    for (const doc of documents) {
      add(`raw/${doc.id.slice(0, 8)}-${safeFilePart(doc.filename)}.md`, doc.extractedText ?? '')
      const original = await this.deps.documents.readSource(doc.id)
      if (original) entries.push({ path: `${root}/raw/${doc.id.slice(0, 8)}-${safeFilePart(doc.filename)}`, bytes: original })
    }
    const schema = wikiId ? (await this.deps.wikis.findByConnectorId(connector.id))?.schemaMd : null
    if (schema) add(WIKI_SCHEMA_PATH, schema)
    await this.audit(connector, actor, 'kb.wiki.exported', connector.id, 'connector', {
      connectorId: connector.id,
      pageCount: pages.length,
      sourceCount: documents.length,
    })
    return { filename: `${root}.zip`, bytes: buildStoredZip(entries) }
  }

  /** Végleges törlés: csak a tulajdonos indíthatja a felületről (D13). */
  async purgePrivate(actor: WikiConsoleActor, connectorId: string) {
    const { connector } = await this.load(actor, connectorId, 'manage')
    if (!isPrivateKnowledgeBase(connector)) throw new WikiConsoleError('forbidden')
    return this.deps.wikiAccess.purgePrivateKnowledgeBase({
      actor: { userId: actor.userId, tenantId: actor.tenantId, role: String(actor.role) },
      connectorId: connector.id,
    })
  }

  // -------------------------------------------------------------------------
  // „Kik férnek hozzá” fül: munkatárs-jogok a tudásbázis felől (#965 folyt.)

  /**
   * A tudásbázishoz kötött munkatársak, és — ha a hívó kezelheti a kötéseket —
   * az összes munkatárs, akinek jogot adhat (admin: mind; más: a view/operate grantosak).
   * Ugyanazt a jogot állítja, mint az agent „Wikik és jogok” kártyája.
   */
  async getAgentAccess(actor: WikiConsoleActor, connectorId: string) {
    const { connector } = await this.load(actor, connectorId, 'view')
    const canEdit = canManageKnowledgeBaseLink(connector, { userId: actor.userId, role: String(actor.role) })
    const [bindings, choices] = await Promise.all([
      this.deps.console.listBindingsForConnector(connector.id),
      canEdit
        ? this.deps.console.listAgentsForWikiAccess(
            actor.tenantId,
            isPrivilegedAgentReader(String(actor.role)) || actor.assumed ? null : actor.userId,
          )
        : Promise.resolve([]),
    ])
    const ownerAgentId = ownerAgentIdForKnowledgeBase(connector.name)
    const editable = new Set(choices.map((agent) => agent.id))
    const rows = new Map<string, {
      agentId: string
      agentName: string
      access: WikiAccess
      writeMode: MemoryWriteMode
      own: boolean
      editable: boolean
    }>()
    for (const agent of choices) {
      rows.set(agent.id, {
        agentId: agent.id,
        agentName: agent.name,
        access: 'none',
        writeMode: isPrivateKnowledgeBase(connector) ? 'direct' : 'approval',
        own: agent.id.toLowerCase() === ownerAgentId,
        editable: true,
      })
    }
    for (const binding of bindings) {
      rows.set(binding.agentId, {
        agentId: binding.agentId,
        agentName: binding.agentName,
        access: effectiveWikiAccess(binding),
        writeMode: effectiveWikiWriteMode(binding),
        own: binding.agentId.toLowerCase() === ownerAgentId,
        editable: editable.has(binding.agentId),
      })
    }
    return {
      canEdit,
      rows: [...rows.values()].sort(
        (a, b) =>
          Number(b.own) - Number(a.own) ||
          Number(b.access !== 'none') - Number(a.access !== 'none') ||
          a.agentName.localeCompare(b.agentName),
      ),
    }
  }

  // -------------------------------------------------------------------------
  // Beállítások: szabályfájl, sablon, láthatóság (#965)

  async getSettings(actor: WikiConsoleActor, connectorId: string) {
    const { connector } = await this.load(actor, connectorId, 'manage')
    const kind = wikiKbKind(connector)
    const wikiId = await this.deps.wiki.wikiIdForConnector(actor.tenantId, connector.id)
    const wiki = wikiId ? await this.deps.wikis.findByConnectorId(connector.id) : null
    const template = configTemplate(connector.config)
    const schemaMd = wiki?.schemaMd ?? defaultWikiSchema(connector.kbLanguage, template)
    return {
      kind,
      template,
      schemaMd,
      /** A szabályfájl eltér-e a választott sablon alapszövegétől. */
      schemaCustomized: schemaMd.trim() !== defaultWikiSchema(connector.kbLanguage, template).trim(),
      visibility: kind === 'private' ? ('private' as const) : ('shared' as const),
      canMakePrivate: kind === 'shared',
      canMakeShared: kind === 'private' && hasMinimumRole(role(actor), 'admin'),
    }
  }

  async updateSchema(actor: WikiConsoleActor, connectorId: string, schemaMd: string) {
    const { connector } = await this.load(actor, connectorId, 'manage')
    const text = schemaMd.replace(/\r\n/g, '\n').trim()
    if (!text || text.length > MAX_WIKI_SCHEMA_CHARS) throw new WikiConsoleError('invalid_args')
    const wikiId = await this.deps.wiki.wikiIdForConnector(actor.tenantId, connector.id)
    if (!wikiId) throw new WikiConsoleError('not_found')
    await this.deps.wikis.updateSchema(wikiId, `${text}\n`)
    await this.audit(connector, actor, 'kb.wiki.schema.updated', wikiId, 'wiki', {
      wikiId,
      contentHash: createHash('sha256').update(text).digest('hex'),
    })
    return { saved: true }
  }

  /** Sablon váltása: a WIKI.md a sablon alapszövegére áll (a meglévő oldalak maradnak). */
  async applyTemplate(actor: WikiConsoleActor, connectorId: string, template: string) {
    const { connector } = await this.load(actor, connectorId, 'manage')
    if (!(WIKI_TEMPLATE_IDS as readonly string[]).includes(template)) throw new WikiConsoleError('invalid_args')
    const choice = template as WikiTemplateChoice
    const wikiId = await this.deps.wiki.wikiIdForConnector(actor.tenantId, connector.id)
    if (!wikiId) throw new WikiConsoleError('not_found')
    await this.deps.connectors.updateKnowledgeBase(connector.id, {
      config: { ...configObject(connector.config), wikiTemplate: choice },
    })
    await this.deps.wikis.updateSchema(wikiId, defaultWikiSchema(connector.kbLanguage, choice))
    await this.audit(connector, actor, 'kb.wiki.template.applied', wikiId, 'wiki', { wikiId, kind: choice })
    return { template: choice }
  }

  /**
   * Láthatóság utólagos váltása (#965).
   * - közös → privát: a kezelő (tenant admin) teheti meg, a tudásbázis az övé lesz;
   * - privát → közös: a tulajdonos, ha admin (közöset csak admin hozhat létre).
   * A munkatárs saját tudásbázisa és a céges katalógus nem váltható. A függő
   * wiki-módosítások elutasítódnak, mert a jóváhagyójuk a régi kör volt.
   */
  async changeVisibility(actor: WikiConsoleActor, connectorId: string, to: 'private' | 'shared') {
    const { connector } = await this.load(actor, connectorId, 'manage')
    const kind = wikiKbKind(connector)
    if (to === 'private' && kind !== 'shared') throw new WikiConsoleError('forbidden')
    if (to === 'shared' && (kind !== 'private' || !hasMinimumRole(role(actor), 'admin'))) {
      throw new WikiConsoleError('forbidden')
    }
    const updated = await this.deps.connectors.updateKnowledgeBase(connector.id, {
      // A connector-név tartalommentes marad; csak az előtag követi a fajtát.
      name: `${to === 'private' ? 'kb:private:' : 'kb:shared:'}${connector.id}`,
      visibility: to === 'private' ? 'private_to_user' : 'shared',
      ownerUserId: to === 'private' ? actor.userId : null,
    })
    const pending = await this.deps.wikis.listPendingChangeSetIds(connector.id)
    let rejected = 0
    for (const changeSetId of pending) {
      const done = await this.deps.wiki.reject(changeSetId, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        reason: 'visibility_changed',
      })
      if (done) rejected++
    }
    await this.audit(updated, actor, 'kb.visibility.changed', connector.id, 'connector', {
      visibility: updated.visibility,
      ownerUserId: updated.ownerUserId,
      rejectedChangeSets: rejected,
    })
    return { visibility: to, rejectedChangeSets: rejected }
  }

  // -------------------------------------------------------------------------
  // Agent-beállítás → Tudásbázis (wiki-jogok)

  /**
   * Az agenthez rendelhető wikik: közös (saját, katalógus, megosztott) és a hívó
   * SAJÁT privát wikijei. Más privát wikije nem szerepel.
   */
  async listAgentWikiLinks(actor: WikiConsoleActor, agentId: string) {
    const agent = await this.deps.agents.findById(agentId, actor.tenantId)
    if (!agent) throw new WikiConsoleError('not_found')
    const [rows, bindings] = await Promise.all([
      this.deps.console.listKnowledgeBases(actor.tenantId),
      this.deps.agents.findConnectorsForAgent(agent.id),
    ])
    const agentNames = await this.deps.console.agentNames(
      actor.tenantId,
      rows.map((row) => ownerAgentIdForKnowledgeBase(row.name)).filter((id): id is string => !!id),
    )
    return rows
      .filter((row) => row.lifecycleState === 'active')
      .filter((row) => (isPrivateKnowledgeBase(row) ? row.ownerUserId === actor.userId : row.visibility === 'shared'))
      .filter((row) => {
        // Más agent saját tudásbázisa csak akkor jelenik meg, ha már kötve van.
        const owner = ownerAgentIdForKnowledgeBase(row.name)
        return !owner || owner === agent.id.toLowerCase() || bindings.some((b) => b.connector.id === row.connectorId)
      })
      .map((row) => {
        const binding = bindings.find((b) => b.connector.id === row.connectorId) ?? null
        const kind = wikiKbKind(row)
        const ownerAgent = ownerAgentIdForKnowledgeBase(row.name)
        return {
          connectorId: row.connectorId,
          kind,
          own: ownerAgent === agent.id.toLowerCase(),
          name:
            kind === 'private'
              ? privateKnowledgeBaseDisplayName({ config: row.config }) ?? 'Private knowledge base'
              : kind === 'catalog'
                ? 'Company knowledge base'
                : kind === 'agent'
                  ? agentNames.get(ownerAgent!) ?? 'Agent knowledge base'
                  : configDisplayName(row.config) ?? row.name,
          template: configTemplate(row.config),
          access: binding ? effectiveWikiAccess(binding) : ('none' as const),
          writeMode: binding ? effectiveWikiWriteMode(binding) : kind === 'private' ? ('direct' as const) : ('approval' as const),
          collectFocus: binding?.wikiCollectFocus ?? null,
          linked: !!binding,
          canEdit: canManageKnowledgeBaseLink(row, { userId: actor.userId, role: String(actor.role) }),
          pageCount: row.pageCount,
        }
      })
      .sort((a, b) => Number(b.own) - Number(a.own) || kindOrder(a.kind) - kindOrder(b.kind) || a.name.localeCompare(b.name))
  }

  async setAgentWikiLink(
    actor: WikiConsoleActor,
    input: {
      agentId: string
      connectorId: string
      wikiAccess: WikiAccess
      wikiWriteMode?: MemoryWriteMode
      wikiCollectFocus?: string | null
    },
  ) {
    const wikiActor = { userId: actor.userId, tenantId: actor.tenantId, role: String(actor.role) }
    const existing = await this.deps.agents.findConnectorBinding(input.agentId, input.connectorId)
    if (!existing && input.wikiAccess === 'none') return { changed: false }
    if (!existing) {
      await this.deps.wikiAccess.linkKnowledgeBase({
        actor: wikiActor,
        agentId: input.agentId,
        connectorId: input.connectorId,
        accessMode: input.wikiAccess === 'write' ? 'write' : 'read',
      })
    }
    const keepsFocus = input.wikiAccess === 'submit' || input.wikiAccess === 'write'
    await this.deps.wikiAccess.setWikiAccess({
      actor: wikiActor,
      agentId: input.agentId,
      connectorId: input.connectorId,
      wikiAccess: input.wikiAccess,
      ...(input.wikiAccess === 'write' && input.wikiWriteMode ? { wikiWriteMode: input.wikiWriteMode } : {}),
      ...(input.wikiCollectFocus !== undefined ? { wikiCollectFocus: keepsFocus ? input.wikiCollectFocus : null } : {}),
    })
    return { changed: true }
  }

  // -------------------------------------------------------------------------
  // Jóváhagyó kártya

  async getChangeSetReview(actor: WikiConsoleActor, changeSetId: string) {
    const decider: WikiDecider & { tenantId: string } = {
      userId: actor.userId,
      role: String(actor.role),
      assumed: actor.assumed,
      tenantId: actor.tenantId,
    }
    if (!(await this.deps.wiki.canDecide(decider, changeSetId))) throw new WikiConsoleError('not_found')
    const preview = await this.deps.wiki.previewChangeSet(actor.tenantId, changeSetId)
    if (!preview) throw new WikiConsoleError('not_found')
    const sourceIds = [
      ...new Set([
        ...preview.changeSet.sourceDocumentIds,
        ...preview.pages.flatMap((page) => page.after.sources.map((ref: WikiSourceRef) => ref.documentId)),
      ]),
    ].filter((id) => /^[0-9a-f-]{36}$/i.test(id))
    const documents = await this.deps.console.listSourceDocuments(preview.connector.id, sourceIds)
    const agentNames = await this.deps.console.agentNames(actor.tenantId, preview.changeSet.agentId ? [preview.changeSet.agentId] : [])
    return {
      changeSetId: preview.changeSet.id,
      status: preview.changeSet.status,
      connectorId: preview.connector.id,
      wikiName: await this.displayName(preview.connector),
      private: isPrivateKnowledgeBase(preview.connector),
      agentName: preview.changeSet.agentId ? agentNames.get(preview.changeSet.agentId) ?? null : null,
      createdAt: preview.changeSet.createdAt.toISOString(),
      logTitle: preview.changeSet.logEntry?.title ?? null,
      logNote: preview.changeSet.logEntry?.note ?? null,
      sources: documents.map((doc) => ({ documentId: doc.id, filename: doc.filename })),
      pages: preview.pages.map((page) => ({
        path: page.path,
        finalPath: page.finalPath,
        kind: changeKind(page),
        othersPage: page.othersPage,
        title: page.after.title || page.before?.title || page.path,
        summary: page.after.summary,
        titleChanged: !!page.before && page.before.title !== page.after.title,
        diff: page.action === 'archive' ? [] : (diffLines(page.before?.body ?? '', page.after.body) as LineDiffRow[]),
        sources: dedupeSources(page.after.sources).map((ref: WikiSourceRef) => ({
          documentId: ref.documentId,
          page: ref.page ?? null,
          section: ref.section ?? null,
          filename: documents.find((doc) => doc.id === ref.documentId)?.filename ?? ref.filename ?? null,
        })),
      })),
      issues: preview.issues.map((issue) => ({
        severity: issue.severity,
        code: issue.code,
        path: issue.path ?? null,
        message: issue.message,
      })),
      blocking: preview.blocking ? { code: preview.blocking.code } : null,
    }
  }

  // -------------------------------------------------------------------------

  private async audit(
    connector: Connector,
    actor: WikiConsoleActor,
    action: string,
    targetId: string,
    targetType: string,
    metadata: Record<string, unknown>,
  ) {
    await this.deps.audit.append(
      redactKbAuditForVisibility(connector, {
        actorType: 'human',
        actorId: actor.userId,
        agentVersion: null,
        action,
        targetType,
        targetId,
        modelUsed: null,
        inputRef: null,
        outputRef: connector.id,
        policyDecision: 'allowed',
        metadata: { ...metadata, userId: actor.userId, connectorId: connector.id },
        tenantId: actor.tenantId,
      }),
    )
  }
}

function configObject(config: unknown): Record<string, unknown> {
  return config && typeof config === 'object' && !Array.isArray(config) ? { ...(config as Record<string, unknown>) } : {}
}

function configTemplate(config: unknown): WikiTemplateChoice {
  return configObject(config).wikiTemplate === 'health-journal' ? 'health-journal' : 'general'
}

function configDisplayName(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null
  const value = (config as Record<string, unknown>).displayName
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Ugyanannak a dokumentumnak az oldal nélküli hivatkozása elhagyható, ha van oldalszámos is. */
function dedupeSources(refs: WikiSourceRef[]): WikiSourceRef[] {
  const withPage = new Set(refs.filter((ref) => ref.page || ref.section).map((ref) => ref.documentId))
  const seen = new Set<string>()
  return refs.filter((ref) => {
    if (!ref.page && !ref.section && withPage.has(ref.documentId)) return false
    const key = `${ref.documentId}|${ref.page ?? ''}|${ref.section ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function kindOrder(kind: WikiKbKind): number {
  return { agent: 0, private: 1, catalog: 2, shared: 3 }[kind]
}

function changeKind(page: { action: string; before: unknown; status: string }): 'new' | 'modified' | 'archived' | 'moved' {
  if (page.action === 'archive' || (page.status === 'archived' && page.action !== 'patch')) return 'archived'
  if (page.action === 'move') return 'moved'
  return page.before ? 'modified' : 'new'
}

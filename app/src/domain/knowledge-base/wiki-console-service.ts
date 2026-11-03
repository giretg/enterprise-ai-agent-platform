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
import type {
  AgentRepository,
  AuditRepository,
  ConnectorRepository,
  DocumentRepository,
  WikiHistoryRepository,
  WikiRepository,
} from '@/repositories/interfaces'
import type { WikiConsoleRepository } from '@/repositories/postgres/wiki-console-repository'
import { hasMinimumRole } from '@/auth/types'
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
  isDefaultWikiSchema,
  extractCrossWikiLinks,
  isDocumentSource,
  isHumanNoteSource,
  readWikiSources,
  visibleWikiSources,
  renderWikiIndex,
  renderWikiLog,
  renderWikiPageMarkdown,
  stripManagedFrontmatter,
  type WikiDocumentSourceRef,
  type WikiSourceRef,
} from '@/lib/kb-wiki'
import { isKbLanguage, type KbLanguage } from '@/lib/kb-language'
import { metaFromColumns, readWikiMeta, type WikiPageMeta } from '@/lib/wiki-metadata'
import { WIKI_MD_MAX_CHARS } from '@/lib/wiki-config'
import {
  categoryIndex,
  groupPagesByTree,
  linkedWikiItems,
  normalizeCategoryPath,
  renderWikiTreeIndex,
  type WikiCategoryRow,
} from '@/lib/wiki-categories'
import {
  KB_CATALOG_CONNECTOR_NAME,
  canManageKnowledgeBaseLink,
  effectiveWikiAccess,
  effectiveWikiWriteMode,
  isKnowledgeBaseMember,
  isKnowledgeBaseVisibleTo,
  isMembersKnowledgeBase,
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
export const MAX_WIKI_SCHEMA_CHARS = WIKI_MD_MAX_CHARS
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

export type WikiKbKind = 'catalog' | 'agent' | 'shared' | 'private' | 'members'

/** #1061 F2: egy forrás a felületen (dokumentum, emberi rögzítés, vagy nem látható másik tudástár). */
export type WikiSourceView =
  | {
      kind: 'document'
      documentId: string
      /** Csak másik tudástár forrásánál. */
      connectorId?: string
      page: number | null
      section: string | null
      filename: string | null
      exists: boolean
    }
  | { kind: 'human_note'; recordedBy: string | null; recordedAt: string; occasion: string; participants: string | null }
  | { kind: 'restricted' }

type Access = { view: boolean; contribute: boolean; manage: boolean; metaOnly: boolean }

export type WikiConsoleDeps = {
  documents: Pick<DocumentRepository, 'readSource'>
  connectors: Pick<ConnectorRepository, 'findById' | 'create' | 'updateKnowledgeBase'>
  agents: Pick<AgentRepository, 'findById' | 'findConnectorsForAgent' | 'findConnectorBinding'>
  wikis: Pick<
    WikiRepository,
    | 'findById'
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
  wiki: Pick<WikiService, 'wikiIdForConnector' | 'previewChangeSet' | 'canDecide' | 'reject'> &
    Partial<Pick<WikiService, 'managedCategories' | 'backlinks' | 'crossBacklinkRows' | 'fieldSettings'>>
  wikiAccess: Pick<WikiAccessService, 'createPrivateKnowledgeBase' | 'linkKnowledgeBase' | 'setWikiAccess' | 'purgePrivateKnowledgeBase'>
  knowledgeBase: Pick<KnowledgeBaseService, 'ingestIntoKnowledgeBase'>
  audit: Pick<AuditRepository, 'append'>
  /** #978: címke szerinti export. */
  history?: Pick<WikiHistoryRepository, 'listTags' | 'stateAt'>
  now?: () => Date
}

function role(actor: WikiConsoleActor): UserRole {
  return actor.role as UserRole
}

function accessFor(
  actor: WikiConsoleActor,
  connector: Pick<Connector, 'visibility' | 'ownerUserId'> & { kbMemberUserIds?: readonly string[] | null },
): Access {
  if (isMembersKnowledgeBase(connector)) {
    // #1061 F2 D9: a tartalmat csak tag látja — az admin is csak tagként; nem-tag admin metaadatot lát.
    const member = isKnowledgeBaseMember(connector, actor.userId)
    const admin = hasMinimumRole(role(actor), 'admin')
    return {
      view: member,
      contribute: member && hasMinimumRole(role(actor), 'operator'),
      manage: member && (connector.ownerUserId === actor.userId || admin),
      metaOnly: !member && admin,
    }
  }
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
  if (isMembersKnowledgeBase(connector)) return 'members'
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

  /** #978: a wiki-előzmények ugyanezzel a kapuval dolgoznak (privátnál admin is `not_found`). */
  authorize(actor: WikiConsoleActor, connectorId: string, need: 'view' | 'contribute' | 'manage') {
    return this.load(actor, connectorId, need)
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

  /** A néző által (élő hozzáféréssel, névsorral is) látott másik tudástár; különben `null`. */
  private async viewableConnector(actor: WikiConsoleActor, connectorId: string): Promise<Connector | null> {
    const target = await this.deps.connectors.findById(connectorId, actor.tenantId)
    if (
      !target || target.tenantId !== actor.tenantId || target.type !== 'knowledge_base' ||
      target.lifecycleState !== 'active' || !accessFor(actor, target).view
    ) return null
    return target
  }

  /** #1061 F2: a törzs wikik közti linkjei a felületnek (a nem látott wiki azonosító nélkül). */
  private async crossLinkViews(actor: WikiConsoleActor, connectorId: string, body: string) {
    const out: Array<{ wikiId: string; path: string; connectorId: string | null; exists: boolean }> = []
    for (const link of extractCrossWikiLinks(body)) {
      const wiki = await this.deps.wikis.findById(link.wikiId)
      const target = wiki && wiki.connectorId !== connectorId ? await this.viewableConnector(actor, wiki.connectorId) : null
      const page = target ? await this.deps.wikis.findPage(target.id, link.path) : null
      out.push({ wikiId: link.wikiId, path: link.path, connectorId: target?.id ?? null, exists: page?.status === 'published' })
    }
    return out
  }

  private async visibleCrossBacklinks(actor: WikiConsoleActor, wikiId: string, path: string) {
    const rows = (await this.deps.wiki.crossBacklinkRows?.(actor.tenantId, wikiId, path)) ?? []
    const visible = new Map<string, Connector | null>()
    const out: Array<{ connectorId: string; wikiName: string; path: string; title: string }> = []
    for (const row of rows) {
      if (!visible.has(row.connectorId)) visible.set(row.connectorId, await this.viewableConnector(actor, row.connectorId))
      const target = visible.get(row.connectorId)
      if (target) out.push({ connectorId: target.id, wikiName: await this.displayName(target), path: row.path, title: row.title })
    }
    return out
  }

  /** #1061 F2: a kapcsolt wikik közül azok, amelyeket a néző is lát (élő hozzáférés, névsor is). */
  private async visibleLinkedWikis(actor: WikiConsoleActor, rows: WikiCategoryRow[]) {
    const out: Array<{ key: string; name: string; parentKey: string | null; connectorId: string }> = []
    for (const item of linkedWikiItems(rows)) {
      const target = await this.deps.connectors.findById(item.linkedConnectorId, actor.tenantId)
      if (
        !target || target.tenantId !== actor.tenantId || target.type !== 'knowledge_base' ||
        target.lifecycleState !== 'active' || !accessFor(actor, target).view
      ) continue
      out.push({ key: item.key, name: item.name, parentKey: item.parentKey, connectorId: target.id })
    }
    return out
  }

  async displayName(connector: Connector): Promise<string> {
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
    const managed = wikiId ? (await this.deps.wiki.managedCategories?.(wikiId)) ?? null : null
    const linkedWikis = managed ? await this.visibleLinkedWikis(actor, managed) : []
    const pageView = (page: WikiPage) => ({
      path: page.path,
      title: page.title,
      summary: page.summary,
      type: page.type,
      updatedAt: page.updatedAt.toISOString(),
      author: author(page, agentNames, users),
    })
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
      /** #1061 F1: kezelt kategóriák — a menü a fát követi (üres kategória is látszik). */
      managedCategories: !!managed,
      /** #1061 F3: metaadat-mezők — „Nézetek” fül, metaadat-doboz az oldalon. */
      managedFields: wikiId ? !!(await this.deps.wiki.fieldSettings?.(wikiId)) : false,
      /** #1061 F2: „kapcsolt wiki” menüpontok — csak az, amelyiket a néző is látja (AC9). */
      linkedWikis,
      menu: managed
        ? groupPagesByTree(pages, managed).map((group) => ({
            key: group.path ?? '__uncategorized',
            name: group.path === null ? null : group.name,
            description: group.description,
            protected: group.protected,
            collapsed: group.collapsed,
            pinned: group.pinned,
            pageCount: group.pageCount,
            pages: group.pages.map(pageView),
            children: group.children.map((child) => ({
              key: child.path ?? '',
              name: child.name,
              description: child.description,
              protected: child.protected,
              collapsed: child.collapsed,
              pinned: child.pinned,
              pageCount: child.pageCount,
              pages: child.pages.map(pageView),
            })),
          }))
        : groupWikiIndex(pages).map((group) => {
            const groupPages = group.pages.map((indexPage) => pageView(pages.find((row) => row.path === indexPage.path)!))
            return {
              key: group.category,
              name: group.category === 'Uncategorized' ? null : group.category,
              description: null,
              protected: false,
              collapsed: false,
              pinned: [] as string[],
              pageCount: groupPages.length,
              pages: groupPages,
              children: [] as Array<{
                key: string
                name: string
                description: string | null
                protected: boolean
                collapsed: boolean
                pinned: string[]
                pageCount: number
                pages: ReturnType<typeof pageView>[]
              }>,
            }
          }),
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

  /**
   * #1061 F2: az oldal forrásai a felületre. Másik tudástár forrását olvasáskor újra
   * ellenőrizzük: akinek nincs hozzáférése, csak egy „nincs hozzáférésed” címkét kap
   * (fájlnév és azonosító nélkül). Az emberi rögzítés a rögzítő nevével jelenik meg.
   */
  private async describeSources(actor: WikiConsoleActor, connectorId: string, refs: WikiSourceRef[]): Promise<WikiSourceView[]> {
    const byConnector = new Map<string, string[]>()
    for (const ref of refs) {
      if (!isDocumentSource(ref) || !/^[0-9a-f-]{36}$/i.test(ref.documentId)) continue
      const owner = ref.connectorId && ref.connectorId !== connectorId ? ref.connectorId : connectorId
      byConnector.set(owner, [...(byConnector.get(owner) ?? []), ref.documentId])
    }
    const readable = new Map<string, Array<{ id: string; filename: string }> | null>()
    for (const [owner, ids] of byConnector) {
      if (owner !== connectorId) {
        const other = await this.deps.connectors.findById(owner, actor.tenantId)
        const visible =
          !!other && other.tenantId === actor.tenantId && other.type === 'knowledge_base' &&
          other.lifecycleState === 'active' && accessFor(actor, other).view
        if (!visible) {
          readable.set(owner, null)
          continue
        }
      }
      readable.set(owner, await this.deps.console.listSourceDocuments(owner, [...new Set(ids)]))
    }
    const users = await this.deps.console.userLabels(refs.filter(isHumanNoteSource).map((ref) => ref.recordedByUserId))
    return refs.map((ref): WikiSourceView => {
      if (isHumanNoteSource(ref)) {
        return {
          kind: 'human_note',
          recordedBy: users.get(ref.recordedByUserId) ?? null,
          recordedAt: ref.recordedAt,
          occasion: ref.occasion,
          participants: ref.participants ?? null,
        }
      }
      const external = !!ref.connectorId && ref.connectorId !== connectorId
      const documents = readable.get(external ? ref.connectorId! : connectorId)
      if (documents === null) return { kind: 'restricted' }
      const doc = documents?.find((row) => row.id === ref.documentId)
      return {
        kind: 'document',
        documentId: ref.documentId,
        ...(external ? { connectorId: ref.connectorId } : {}),
        page: ref.page ?? null,
        section: ref.section ?? null,
        filename: doc?.filename ?? (external ? null : ref.filename ?? null),
        exists: !!doc,
      }
    })
  }

  async getPage(actor: WikiConsoleActor, connectorId: string, path: string) {
    const { connector } = await this.load(actor, connectorId, 'view')
    const page = await this.deps.wikis.findPage(connector.id, path.trim())
    if (!page || page.status === 'pending_approval') throw new WikiConsoleError('not_found')
    const [revisions, published] = await Promise.all([
      this.deps.wikis.listRevisions(page.id),
      this.deps.wikis.listPages(connector.id, { status: 'published' }),
    ])
    const sources = await this.describeSources(actor, connector.id, readWikiSources(page.sourceRefs))
    const agentNames = await this.deps.console.agentNames(
      actor.tenantId,
      [page.createdByAgentId, page.updatedByAgentId].filter((id): id is string => !!id),
    )
    const users = await this.deps.console.userLabels(page.createdByUserId ? [page.createdByUserId] : [])
    const wikiId = await this.deps.wiki.wikiIdForConnector(actor.tenantId, connector.id)
    const managed = wikiId ? (await this.deps.wiki.managedCategories?.(wikiId)) ?? null : null
    const backlinks = page.status === 'published' ? await this.deps.wiki.backlinks?.(connector.id, page.path, 2_147_483_647) : null
    const crossLinks = await this.crossLinkViews(actor, connector.id, page.body)
    const crossBacklinks =
      page.status === 'published' && wikiId ? await this.visibleCrossBacklinks(actor, wikiId, page.path) : []
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
      sources,
      knownPaths: published.map((row) => row.path),
      /** #1061 F2: `[[wiki:<wikiId>/<path>]]` linkek — `connectorId: null` = a néző nem látja azt a wikit. */
      crossLinks,
      /** #1061 F2: más wikik oldalai, amelyek ide mutatnak — csak a néző által látott wikikből. */
      crossBacklinks,
      categoryName: categoryLabel(page.category, managed),
      /** #1061 F1: „Erre az oldalra hivatkozik (N)”, kategória szerint csoportosítva. */
      backlinks: backlinks
        ? { count: backlinks.count, shown: backlinks.pages.length, groups: groupBacklinks(backlinks.pages, managed) }
        : null,
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

  async exportZip(
    actor: WikiConsoleActor,
    connectorId: string,
    options: { tag?: string } = {},
  ): Promise<{ filename: string; bytes: Uint8Array }> {
    const { connector } = await this.load(actor, connectorId, 'manage')
    const wikiId = await this.deps.wiki.wikiIdForConnector(actor.tenantId, connector.id)
    // #978 §5.5: „Exportálás ebben az állapotban” — egy címke szerinti állapot.
    let tagged: { name: string; seq: number } | null = null
    let pages: Array<Pick<WikiPage, 'path' | 'type' | 'title' | 'summary' | 'category' | 'frontmatter' | 'body' | 'sourceRefs' | 'status'> & { meta?: WikiPageMeta | null }>
    if (options.tag) {
      if (!wikiId || !this.deps.history) throw new WikiConsoleError('not_found')
      const tag = (await this.deps.history.listTags(wikiId)).find((row) => row.name === options.tag)
      if (!tag) throw new WikiConsoleError('not_found')
      tagged = { name: tag.name, seq: tag.seq }
      pages = (await this.deps.history.stateAt(wikiId, connector.id, tag.seq))
        .filter((row) => !row.erasedAt && row.path && row.status !== 'pending_approval')
        .map((row) => ({
          path: row.path!,
          type: row.type ?? 'entity',
          title: row.title,
          summary: row.summary,
          category: row.category,
          frontmatter: row.frontmatter,
          body: row.body,
          sourceRefs: row.sourceRefs ?? [],
          status: row.status === 'archived' ? 'archived' : 'published',
          meta: readWikiMeta(row.meta),
        }))
    } else {
      pages = await this.deps.wikis.listPages(connector.id, { status: ['published', 'archived'] })
    }
    const documents = await this.deps.console.listSourceDocuments(connector.id)
    const name = await this.displayName(connector)
    const root = safeFilePart(tagged ? `${name} - ${tagged.name}` : name)
    const encoder = new TextEncoder()
    const entries: ZipWriteEntry[] = []
    const add = (path: string, text: string) => entries.push({ path: `${root}/${path}`, bytes: encoder.encode(text) })
    const published = pages.filter((page) => page.status === 'published')
    const managed = wikiId ? (await this.deps.wiki.managedCategories?.(wikiId)) ?? null : null
    add(WIKI_INDEX_PATH, managed ? renderWikiTreeIndex(published, managed) : renderWikiIndex(published))
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
        // #1061 F3: a beépített mezők OKF-frontmatterként (címkés exportnál az akkori érték).
        meta: 'meta' in page ? page.meta ?? undefined : metaFromColumns(page as WikiPage),
        sources: await visibleWikiSources(readWikiSources(page.sourceRefs), connector.id, async id => !!(await this.viewableConnector(actor, id))),
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
      ...(tagged ? { seq: tagged.seq } : {}),
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
    const template = configTemplate(connector.config)
    const [bindings, choices] = await Promise.all([
      this.deps.console.listBindingsForConnector(connector.id),
      canEdit
        ? this.deps.console.listAgentsForWikiAccess(
            actor.tenantId,
            hasMinimumRole(role(actor), 'admin') ? null : actor.userId,
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
      collectFocus: string | null
      template: WikiTemplateChoice
      own: boolean
      editable: boolean
    }>()
    for (const agent of choices) {
      rows.set(agent.id, {
        agentId: agent.id,
        agentName: agent.name,
        access: 'none',
        writeMode: isPrivateKnowledgeBase(connector) ? 'direct' : 'approval',
        collectFocus: null,
        template,
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
        collectFocus: binding.wikiCollectFocus,
        template,
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
      schemaCustomized: !isDefaultWikiSchema(schemaMd, connector.kbLanguage, template),
      visibility: kind === 'private' ? ('private' as const) : kind === 'members' ? ('members' as const) : ('shared' as const),
      canMakePrivate: kind === 'shared' || (kind === 'members' && connector.ownerUserId === actor.userId),
      canMakeShared: (kind === 'private' || kind === 'members') && hasMinimumRole(role(actor), 'admin'),
      canMakeMembers: kind === 'shared' || kind === 'private',
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
   * Láthatóság utólagos váltása (#965, #1061 F2).
   * - közös → privát / névsoros: a kezelő (tenant admin) teheti meg, a tudásbázis az övé lesz;
   * - privát → közös: a tulajdonos, ha admin (közöset csak admin hozhat létre);
   * - privát → névsoros: a tulajdonos (ő az első tag);
   * - névsoros → közös: admin tag; névsoros → privát: a tulajdonos (a többi tag kiesik).
   * A munkatárs saját tudásbázisa és a céges katalógus nem váltható. A függő
   * wiki-módosítások elutasítódnak, mert a jóváhagyójuk a régi kör volt.
   */
  async changeVisibility(actor: WikiConsoleActor, connectorId: string, to: 'private' | 'shared' | 'members') {
    const { connector } = await this.load(actor, connectorId, 'manage')
    const plan = visibilityTransition(actor, connector, to)
    if (!plan) throw new WikiConsoleError('forbidden')
    const updated = await this.deps.connectors.updateKnowledgeBase(connector.id, {
      // A connector-név tartalommentes marad; csak az előtag követi a fajtát.
      name: `${KB_NAME_PREFIX[to]}${connector.id}`,
      visibility: plan.visibility,
      ownerUserId: plan.ownerUserId,
      kbMemberUserIds: plan.memberUserIds,
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
      memberCount: plan.memberUserIds.length,
      rejectedChangeSets: rejected,
    })
    return { visibility: to, rejectedChangeSets: rejected }
  }

  /**
   * #1061 NFR-1: előnézet a váltás előtt — ki veszti el a hozzáférést, mely
   * munkatársak látják ezentúl csak tagokkal beszélve, hány függő módosítás esik ki.
   */
  async previewVisibilityChange(actor: WikiConsoleActor, connectorId: string, to: 'private' | 'shared' | 'members') {
    const { connector } = await this.load(actor, connectorId, 'manage')
    const plan = visibilityTransition(actor, connector, to)
    if (!plan) throw new WikiConsoleError('forbidden')
    const [users, bindings, pending] = await Promise.all([
      this.deps.console.listTenantUsers(actor.tenantId),
      this.deps.console.listBindingsForConnector(connector.id),
      this.deps.wikis.listPendingChangeSetIds(connector.id),
    ])
    const after = { visibility: plan.visibility, ownerUserId: plan.ownerUserId, kbMemberUserIds: plan.memberUserIds }
    const losing = users.filter((user) => isKnowledgeBaseVisibleTo(connector, user.id) && !isKnowledgeBaseVisibleTo(after, user.id))
    return {
      to,
      losingAccess: { count: losing.length, sample: losing.slice(0, 12).map((user) => user.label) },
      /** Ezek a munkatársak a wikit ezentúl csak azzal beszélve látják, aki hozzáfér. */
      restrictedAgents: plan.visibility === 'shared'
        ? []
        : bindings.filter((binding) => effectiveWikiAccess(binding) !== 'none').map((binding) => binding.agentName),
      rejectedChangeSets: pending.length,
    }
  }

  // -------------------------------------------------------------------------
  // #1061 F2: „csak a kijelöltek” névsor

  /**
   * A névsor: tag látja; a nem-tag admin is (metaadat), hogy felvehesse magát (D9).
   * Szerkesztheti a tulajdonos és az admin — az admin tag nélkül is.
   */
  async getMembers(actor: WikiConsoleActor, connectorId: string) {
    const connector = await this.membersConnector(actor, connectorId)
    const canEdit = canEditKnowledgeBaseMembers(actor, connector)
    const [labels, candidates] = await Promise.all([
      this.deps.console.userLabels(connector.kbMemberUserIds),
      canEdit ? this.deps.console.listTenantUsers(actor.tenantId) : Promise.resolve([]),
    ])
    return {
      canEdit,
      isMember: isKnowledgeBaseMember(connector, actor.userId),
      members: connector.kbMemberUserIds
        .map((userId) => ({ userId, label: labels.get(userId) ?? null, owner: userId === connector.ownerUserId }))
        .sort((a, b) => Number(b.owner) - Number(a.owner) || (a.label ?? '').localeCompare(b.label ?? '')),
      candidates: candidates.filter((user) => !connector.kbMemberUserIds.includes(user.id)),
    }
  }

  async addMember(actor: WikiConsoleActor, connectorId: string, userId: string) {
    const connector = await this.membersConnector(actor, connectorId)
    if (!canEditKnowledgeBaseMembers(actor, connector)) throw new WikiConsoleError('forbidden')
    if (connector.kbMemberUserIds.includes(userId)) return { added: false }
    const users = await this.deps.console.listTenantUsers(actor.tenantId)
    if (!users.some((user) => user.id === userId)) throw new WikiConsoleError('invalid_args')
    const updated = await this.deps.connectors.updateKnowledgeBase(connector.id, {
      expectedMemberUserIds: connector.kbMemberUserIds,
      kbMemberUserIds: [...connector.kbMemberUserIds, userId],
    })
    // D9: ha az admin önmagát veszi fel, az külön kiemelt esemény.
    const selfAdded = userId === actor.userId
    await this.audit(updated, actor, selfAdded ? 'kb.members.self_added' : 'kb.members.added', connector.id, 'connector', {
      memberUserId: userId,
      memberCount: updated.kbMemberUserIds.length,
    })
    return { added: true }
  }

  async removeMember(actor: WikiConsoleActor, connectorId: string, userId: string) {
    const connector = await this.membersConnector(actor, connectorId)
    if (!canEditKnowledgeBaseMembers(actor, connector)) throw new WikiConsoleError('forbidden')
    // A tulajdonos nem eshet ki: ő a jóváhagyó és a névsor gazdája.
    if (userId === connector.ownerUserId) throw new WikiConsoleError('invalid_args')
    if (!connector.kbMemberUserIds.includes(userId)) return { removed: false }
    const updated = await this.deps.connectors.updateKnowledgeBase(connector.id, {
      expectedMemberUserIds: connector.kbMemberUserIds,
      kbMemberUserIds: connector.kbMemberUserIds.filter((id) => id !== userId),
    })
    await this.audit(updated, actor, 'kb.members.removed', connector.id, 'connector', {
      memberUserId: userId,
      memberCount: updated.kbMemberUserIds.length,
    })
    return { removed: true }
  }

  /** Csak névsoros tudástár; tagnak és adminnak „létezik” (a privát mintájára más `not_found`). */
  private async membersConnector(actor: WikiConsoleActor, connectorId: string) {
    const connector = await this.deps.connectors.findById(connectorId, actor.tenantId)
    if (!connector || connector.tenantId !== actor.tenantId || connector.type !== 'knowledge_base') {
      throw new WikiConsoleError('not_found')
    }
    const access = accessFor(actor, connector)
    if (!access.view && !access.metaOnly) throw new WikiConsoleError('not_found')
    if (!isMembersKnowledgeBase(connector)) throw new WikiConsoleError('invalid_args')
    return connector
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
      .filter((row) =>
        isPrivateKnowledgeBase(row)
          ? row.ownerUserId === actor.userId
          : isMembersKnowledgeBase(row)
            ? isKnowledgeBaseMember(row, actor.userId)
            : row.visibility === 'shared',
      )
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
        ...preview.pages.flatMap((page) =>
          page.after.sources.filter((ref) => isDocumentSource(ref) && !ref.connectorId).map((ref) => (ref as WikiDocumentSourceRef).documentId),
        ),
      ]),
    ].filter((id) => /^[0-9a-f-]{36}$/i.test(id))
    const documents = await this.deps.console.listSourceDocuments(preview.connector.id, sourceIds)
    const pageSources = await Promise.all(
      preview.pages.map((page) => this.describeSources(actor, preview.connector.id, dedupeSources(page.after.sources))),
    )
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
      pages: preview.pages.map((page, index) => ({
        path: page.path,
        finalPath: page.finalPath,
        kind: changeKind(page),
        othersPage: page.othersPage,
        protectedCategory: page.protectedCategory,
        /** #1061 F3: az agent jóváhagyott állapotot kér (a jóváhagyó döntése állítja be). */
        docStatusChange: page.docStatusChange,
        title: page.after.title || page.before?.title || page.path,
        summary: page.after.summary,
        titleChanged: !!page.before && page.before.title !== page.after.title,
        diff: page.action === 'archive' ? [] : (diffLines(page.before?.body ?? '', page.after.body) as LineDiffRow[]),
        sources: pageSources[index],
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

/** #1061: a kategória olvasható neve („Partnerek › Fizetés”); kezeletlen wikinél maga a szöveg. */
function categoryLabel(category: string | null, managed: WikiCategoryRow[] | null): string | null {
  if (!category?.trim()) return null
  if (!managed) return category.trim()
  const node = categoryIndex(managed).get(normalizeCategoryPath(category))
  if (!node) return category.trim()
  const parent = node.parentId ? managed.find((row) => row.id === node.parentId) : null
  return parent ? `${parent.name} › ${node.name}` : node.name
}

function groupBacklinks(
  pages: Array<{ path: string; title: string; category: string | null }>,
  managed: WikiCategoryRow[] | null,
): Array<{ category: string | null; pages: Array<{ path: string; title: string }> }> {
  const groups = new Map<string, { category: string | null; pages: Array<{ path: string; title: string }> }>()
  for (const page of pages) {
    const label = categoryLabel(page.category, managed)
    const key = label ?? ''
    const group = groups.get(key) ?? { category: label, pages: [] }
    group.pages.push({ path: page.path, title: page.title })
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) =>
    a.category === null ? 1 : b.category === null ? -1 : a.category.localeCompare(b.category),
  )
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
  const docKey = (ref: WikiDocumentSourceRef) => `${ref.connectorId ?? ''}|${ref.documentId}`
  const withPage = new Set(refs.filter(isDocumentSource).filter((ref) => ref.page || ref.section).map(docKey))
  const seen = new Set<string>()
  return refs.filter((ref) => {
    if (isHumanNoteSource(ref)) return true
    if (!ref.page && !ref.section && withPage.has(docKey(ref))) return false
    const key = `${docKey(ref)}|${ref.page ?? ''}|${ref.section ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function kindOrder(kind: WikiKbKind): number {
  return { agent: 0, private: 1, members: 2, catalog: 3, shared: 4 }[kind]
}

const KB_NAME_PREFIX = { private: 'kb:private:', shared: 'kb:shared:', members: 'kb:members:' } as const

/** #1061 F2 D9: a névsort a tulajdonos és az admin szerkeszti — az admin tagság nélkül is (önmagát felveheti). */
function canEditKnowledgeBaseMembers(actor: WikiConsoleActor, connector: Pick<Connector, 'ownerUserId'>): boolean {
  return connector.ownerUserId === actor.userId || hasMinimumRole(role(actor), 'admin')
}

/** Az engedett láthatóság-váltások (lásd `changeVisibility`); `null` = tilos. */
function visibilityTransition(
  actor: WikiConsoleActor,
  connector: Connector,
  to: 'private' | 'shared' | 'members',
): { visibility: Connector['visibility']; ownerUserId: string | null; memberUserIds: string[] } | null {
  const kind = wikiKbKind(connector)
  const admin = hasMinimumRole(role(actor), 'admin')
  const owner = !!connector.ownerUserId && connector.ownerUserId === actor.userId
  if (to === 'private') {
    if (kind === 'shared' || (kind === 'members' && owner)) {
      return { visibility: 'private_to_user', ownerUserId: actor.userId, memberUserIds: [] }
    }
    return null
  }
  if (to === 'shared') {
    if ((kind === 'private' || kind === 'members') && admin) return { visibility: 'shared', ownerUserId: null, memberUserIds: [] }
    return null
  }
  if (kind === 'shared' || (kind === 'private' && owner)) {
    return { visibility: 'members', ownerUserId: actor.userId, memberUserIds: [actor.userId] }
  }
  return null
}

function changeKind(page: { action: string; before: unknown; status: string }): 'new' | 'modified' | 'archived' | 'moved' {
  if (page.action === 'archive' || (page.status === 'archived' && page.action !== 'patch')) return 'archived'
  if (page.action === 'move') return 'moved'
  return page.before ? 'modified' : 'new'
}

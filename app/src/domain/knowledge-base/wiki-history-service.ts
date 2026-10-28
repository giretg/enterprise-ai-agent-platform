/**
 * #978 Wiki-előzmények a Control Plane-en: idővonal, verzió-összevetés,
 * change-set nézet, visszaállítás (D2/D5/D8), időutazás, címkék, megőrzés (D1)
 * és auditált GDPR-törlés (D9/D10).
 *
 * A jogot a `WikiConsoleService.authorize` dönti el (privát KB-nál az admin is
 * `not_found`, D13); itt csak a műveletenkénti többletjog van (§8).
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Connector, Prisma, WikiChangeSet, WikiPage, WikiPageRevision } from '@prisma/client'
import { hasMinimumRole } from '@/auth/types'
import type { UserRole } from '@prisma/client'
import { redactKbAuditForVisibility } from '@/lib/audit/kb-private-redaction'
import { diffLines, type LineDiffRow } from '@/lib/text-line-diff'
import {
  groupWikiIndex,
  readWikiSources,
  stripManagedFrontmatter,
  wikiPageContentHash,
  type WikiPageState,
  type WikiPageTypeName,
} from '@/lib/kb-wiki'
import { canDecideWikiChange, isPrivateKnowledgeBase, type WikiApproverScope } from '@/lib/wiki-access'
import type {
  AuditRepository,
  ConnectorRepository,
  WikiChangeSetPageSummary,
  WikiErasureWrite,
  WikiHistoryRepository,
  WikiRepository,
} from '@/repositories/interfaces'
import type { WikiConsoleRepository } from '@/repositories/postgres/wiki-console-repository'
import { WikiConsoleError, type WikiConsoleActor, type WikiConsoleService } from './wiki-console-service'
import { pageChunks, readPageSummary, type WikiRevertTarget, type WikiService } from './wiki-service'

/** D1: a választható megőrzési idők (nap). */
export const WIKI_RETENTION_FULL_OPTIONS = [30, 90, 180, 365] as const
export const WIKI_RETENTION_DELETE_OPTIONS = [90, 365, 730, 1825] as const
/** Oldalanként mindig megmaradó legutóbbi verziók (D1). */
export const WIKI_RETENTION_KEEP_LATEST = 5
/** Kötegméret wikinként / futásonként (Neon-pool, §6). */
export const WIKI_RETENTION_BATCH = 1000
export const WIKI_ERASURE_MIN_PHRASE = 3
export const WIKI_ERASURE_MARK = '[törölve]'

export type WikiErasureScopeInput =
  | { kind: 'pages'; paths: string[] }
  | { kind: 'revision'; path: string; version: number }
  | { kind: 'text'; phrase: string; mode: 'redact' | 'erase' }

export type WikiErasureLocation =
  | 'page'
  | 'revision'
  | 'changeSet'
  | 'log'
  | 'document'
  | 'sourceFile'
  | 'chunk'
  | 'gatewayOperation'

export type WikiHistoryDeps = {
  history: WikiHistoryRepository
  wikis: Pick<WikiRepository, 'findPage' | 'findChangeSet' | 'listLog' | 'findByConnectorId'>
  connectors: Pick<ConnectorRepository, 'findById'>
  console: Pick<WikiConsoleRepository, 'agentNames' | 'userLabels'>
  wikiConsole: Pick<WikiConsoleService, 'authorize' | 'displayName'>
  wiki: Pick<WikiService, 'wikiIdForConnector' | 'revertAsHuman' | 'resolveAsOf' | 'approverScopeFor'>
  audit: Pick<AuditRepository, 'append'>
  now?: () => Date
}

type Author = { kind: 'agent' | 'human'; name: string | null } | null

export class WikiHistoryService {
  constructor(private readonly deps: WikiHistoryDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date()
  }

  private async open(actor: WikiConsoleActor, connectorId: string, need: 'view' | 'contribute' | 'manage') {
    const { connector, access } = await this.deps.wikiConsole.authorize(actor, connectorId, need)
    const wikiId = await this.deps.wiki.wikiIdForConnector(actor.tenantId, connector.id)
    if (!wikiId) throw new WikiConsoleError('not_found')
    return { connector, access, wikiId }
  }

  /** §8: visszaállítás — közösnél a wiki jóváhagyója és a tenant-admin, privátnál a tulajdonos. */
  private async canRevert(actor: WikiConsoleActor, connector: Connector): Promise<boolean> {
    if (isPrivateKnowledgeBase(connector)) return connector.ownerUserId === actor.userId
    const scope: WikiApproverScope = await this.deps.wiki.approverScopeFor(connector)
    return canDecideWikiChange({ userId: actor.userId, role: String(actor.role), assumed: actor.assumed }, scope)
  }

  /** §8: címke — közösnél szerkesztő (operátor) vagy admin, privátnál a tulajdonos. */
  private canTag(actor: WikiConsoleActor, connector: Connector): boolean {
    if (isPrivateKnowledgeBase(connector)) return connector.ownerUserId === actor.userId
    return hasMinimumRole(actor.role as UserRole, 'operator')
  }

  private async authors(tenantId: string, rows: Array<{ agentId: string | null; userId: string | null }>) {
    const agents = await this.deps.console.agentNames(
      tenantId,
      rows.map((row) => row.agentId).filter((id): id is string => !!id),
    )
    const users = await this.deps.console.userLabels(
      rows.filter((row) => !row.agentId && row.userId).map((row) => row.userId!),
    )
    return (row: { agentId: string | null; userId: string | null }): Author => {
      if (row.agentId) return { kind: 'agent', name: agents.get(row.agentId) ?? null }
      if (row.userId) return { kind: 'human', name: users.get(row.userId) ?? null }
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Oldal-idővonal, verzió, összevetés (§5.1)

  private async pageByPath(connector: Connector, path: string): Promise<WikiPage> {
    const page = await this.deps.wikis.findPage(connector.id, path.trim())
    if (!page || page.status === 'pending_approval') throw new WikiConsoleError('not_found')
    return page
  }

  async getPageHistory(actor: WikiConsoleActor, connectorId: string, path: string) {
    const { connector, wikiId } = await this.open(actor, connectorId, 'view')
    const page = await this.pageByPath(connector, path)
    const [revisions, tags] = await Promise.all([
      this.deps.history.listRevisions(connector.id, page.id),
      this.deps.history.listTags(wikiId),
    ])
    const author = await this.authors(
      actor.tenantId,
      revisions.map((rev) => ({ agentId: rev.createdByAgentId, userId: rev.createdByUserId })),
    )
    // Egy címke annál a verziónál áll, amely a címke sorszámán érvényes volt.
    const tagsByVersion = new Map<number, string[]>()
    for (const tag of tags) {
      const rev = revisions.find((row) => row.seq !== null && row.seq <= tag.seq)
      if (rev) tagsByVersion.set(rev.version, [...(tagsByVersion.get(rev.version) ?? []), tag.name])
    }
    return {
      path: page.path,
      title: page.title,
      currentVersion: page.version,
      canRevert: await this.canRevert(actor, connector),
      revisions: revisions.map((rev) => ({
        version: rev.version,
        createdAt: rev.createdAt.toISOString(),
        seq: rev.seq,
        logTitle: rev.changeSetLogTitle,
        title: rev.erasedAt ? null : rev.title,
        path: rev.path,
        status: rev.status,
        author: author({ agentId: rev.createdByAgentId, userId: rev.createdByUserId }),
        erased: !!rev.erasedAt,
        /** Bevezetés előtti verzió: az áthelyezés / archiválás nem pontos. */
        legacy: rev.type === null,
        current: rev.version === page.version,
        tags: tagsByVersion.get(rev.version) ?? [],
      })),
    }
  }

  async getRevision(actor: WikiConsoleActor, connectorId: string, path: string, version: number) {
    const { connector } = await this.open(actor, connectorId, 'view')
    const page = await this.pageByPath(connector, path)
    const rev = await this.deps.history.findRevision(connector.id, page.id, version)
    if (!rev) throw new WikiConsoleError('not_found')
    const author = await this.authors(actor.tenantId, [{ agentId: rev.createdByAgentId, userId: rev.createdByUserId }])
    return {
      path: page.path,
      version: rev.version,
      currentVersion: page.version,
      createdAt: rev.createdAt.toISOString(),
      erased: !!rev.erasedAt,
      title: rev.erasedAt ? '' : rev.title,
      summary: rev.erasedAt ? '' : rev.summary,
      body: rev.erasedAt ? '' : rev.body,
      revisionPath: rev.path,
      status: rev.status,
      sources: rev.erasedAt ? [] : readWikiSources(rev.sourceRefs ?? page.sourceRefs),
      author: author({ agentId: rev.createdByAgentId, userId: rev.createdByUserId }),
      canRevert: rev.version !== page.version && !rev.erasedAt && (await this.canRevert(actor, connector)),
    }
  }

  /** Két verzió: a törzs sor-diffet kap, a többi mező „volt → lett” sort (§5.1). */
  async diffRevisions(actor: WikiConsoleActor, connectorId: string, path: string, fromVersion: number, toVersion: number) {
    const { connector } = await this.open(actor, connectorId, 'view')
    const page = await this.pageByPath(connector, path)
    const [from, to] = await Promise.all([
      this.deps.history.findRevision(connector.id, page.id, fromVersion),
      this.deps.history.findRevision(connector.id, page.id, toVersion),
    ])
    if (!from || !to) throw new WikiConsoleError('not_found')
    return {
      path: page.path,
      from: { version: from.version, createdAt: from.createdAt.toISOString(), erased: !!from.erasedAt },
      to: { version: to.version, createdAt: to.createdAt.toISOString(), erased: !!to.erasedAt },
      ...revisionDiff(from, to, page),
    }
  }

  // -------------------------------------------------------------------------
  // „Változások” fül + change-set nézet (§5.1)

  async listChanges(
    actor: WikiConsoleActor,
    connectorId: string,
    filter: { author?: string; from?: string; to?: string; beforeSeq?: number; limit?: number } = {},
  ) {
    const { connector, wikiId } = await this.open(actor, connectorId, 'view')
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
    const [agentId, userId] = parseAuthorFilter(filter.author)
    const rows = await this.deps.history.listChangeSets(wikiId, {
      order: 'desc',
      limit: limit + 1,
      beforeSeq: filter.beforeSeq,
      agentId,
      userId,
      from: parseDay(filter.from, 'start'),
      to: parseDay(filter.to, 'end'),
    })
    const page = rows.slice(0, limit)
    const author = await this.authors(actor.tenantId, page)
    const seqById = await this.seqLookup(page)
    const [tags, latestSeq] = await Promise.all([this.deps.history.listTags(wikiId), this.deps.history.latestSeq(wikiId)])
    const authorChoices = new Map<string, { key: string; name: string | null; kind: 'agent' | 'human' }>()
    for (const row of page) {
      const key = row.agentId ? `agent:${row.agentId}` : row.userId ? `user:${row.userId}` : null
      const who = author(row)
      if (key && who) authorChoices.set(key, { key, ...who })
    }
    return {
      wikiId,
      latestSeq,
      canRevert: await this.canRevert(actor, connector),
      canTag: this.canTag(actor, connector),
      tags: tags.map((tag) => ({ id: tag.id, name: tag.name, note: tag.note, seq: tag.seq, createdAt: tag.createdAt.toISOString() })),
      authors: [...authorChoices.values()],
      nextBeforeSeq: rows.length > limit ? page[page.length - 1]?.seq ?? null : null,
      changes: page.map((row) => changeRow(row, author(row), seqById)),
    }
  }

  private async seqLookup(rows: WikiChangeSet[]) {
    const ids = new Set(rows.flatMap((row) => [row.revertsId, row.revertedById]).filter((id): id is string => !!id))
    const map = new Map<string, number | null>()
    for (const id of ids) map.set(id, (await this.deps.wikis.findChangeSet(id))?.seq ?? null)
    return map
  }

  /** Egy alkalmazott change-set olvasó nézete: oldalanként előtte → utána (a revíziókból). */
  async getChangeSet(actor: WikiConsoleActor, connectorId: string, seq: number) {
    const { connector, wikiId } = await this.open(actor, connectorId, 'view')
    const changeSet = await this.deps.history.findChangeSetBySeq(wikiId, seq)
    if (!changeSet || changeSet.connectorId !== connector.id) throw new WikiConsoleError('not_found')
    const revisions = await this.deps.history.revisionsForChangeSet(changeSet.id)
    const author = await this.authors(actor.tenantId, [changeSet])
    const seqById = await this.seqLookup([changeSet])
    const summary = readPageSummary(changeSet.pageSummary)
    const pages = []
    for (const rev of revisions) {
      const current = await this.deps.history.findPageById(connector.id, rev.pageId)
      const before = await this.deps.history.previousRevision(connector.id, rev.pageId, rev.version)
      const row = summary.find((item) => item.pageId === rev.pageId)
      const prunedBefore = !!before && before.version !== rev.version - 1
      pages.push({
        pageId: rev.pageId,
        path: rev.path ?? current?.path ?? '',
        currentPath: current?.path ?? null,
        fromPath: row?.fromPath ?? null,
        action: row?.action ?? (before ? 'updated' : 'created'),
        title: rev.erasedAt ? null : rev.title,
        version: rev.version,
        erased: !!rev.erasedAt || !!before?.erasedAt,
        prunedBefore,
        linesAdded: row?.linesAdded ?? null,
        linesRemoved: row?.linesRemoved ?? null,
        ...(rev.erasedAt || before?.erasedAt || !current ? { fields: [], diff: [] as LineDiffRow[] } : revisionDiff(before, rev, current)),
      })
    }
    const log = (changeSet.logEntry ?? {}) as { op?: string; title?: string; note?: string | null }
    return {
      seq: changeSet.seq,
      changeSetId: changeSet.id,
      status: changeSet.status,
      appliedAt: changeSet.appliedAt?.toISOString() ?? null,
      author: author(changeSet),
      op: log.op ?? null,
      logTitle: log.title ?? null,
      logNote: log.note ?? null,
      revertsSeq: changeSet.revertsId ? seqById.get(changeSet.revertsId) ?? null : null,
      revertedBySeq: changeSet.revertedById ? seqById.get(changeSet.revertedById) ?? null : null,
      canRevert: changeSet.status === 'applied' && (await this.canRevert(actor, connector)),
      pages,
    }
  }

  // -------------------------------------------------------------------------
  // Visszaállítás (§5.2) — azonnal alkalmazódik, új change-setként (D5)

  async previewRevert(actor: WikiConsoleActor, connectorId: string, target: WikiRevertTarget) {
    const { connector, wikiId } = await this.open(actor, connectorId, 'view')
    if (!(await this.canRevert(actor, connector))) throw new WikiConsoleError('forbidden')
    if (target.kind === 'page') {
      const page = await this.pageByPath(connector, target.path)
      return { pageCount: 1, pages: [page.path], conflicts: [] as Array<{ path: string; reason: string }> }
    }
    const changeSet = await this.deps.history.findChangeSetBySeq(wikiId, target.seq)
    if (!changeSet || changeSet.connectorId !== connector.id) throw new WikiConsoleError('not_found')
    const revisions = await this.deps.history.revisionsForChangeSet(changeSet.id)
    const conflicts: Array<{ path: string; reason: string }> = []
    const pages: string[] = []
    for (const rev of revisions) {
      const page = await this.deps.history.findPageById(connector.id, rev.pageId)
      const path = page?.path ?? rev.path ?? ''
      pages.push(path)
      if (!page || page.version !== rev.version) conflicts.push({ path, reason: 'changed_since' })
    }
    return { pageCount: pages.length, pages, conflicts }
  }

  async revert(actor: WikiConsoleActor, connectorId: string, target: WikiRevertTarget) {
    const { connector, wikiId } = await this.open(actor, connectorId, 'view')
    if (!(await this.canRevert(actor, connector))) throw new WikiConsoleError('forbidden')
    const result = await this.deps.wiki.revertAsHuman({
      tenantId: actor.tenantId,
      userId: actor.userId,
      connector,
      wikiId,
      target,
    })
    if (!result.ok) {
      const conflicts = Array.isArray(result.details?.conflicts)
        ? (result.details!.conflicts as Array<{ path?: string; reason?: string }>).map((row) => ({
            path: String(row.path ?? ''),
            reason: String(row.reason ?? 'changed_since'),
          }))
        : []
      return { ok: false as const, code: result.code, conflicts }
    }
    return { ok: true as const, seq: result.result.seq, pageCount: result.result.pages.length }
  }

  // -------------------------------------------------------------------------
  // Időutazás (§5.3)

  async getStateAt(actor: WikiConsoleActor, connectorId: string, asOf: string) {
    const { connector, wikiId } = await this.open(actor, connectorId, 'view')
    const resolved = await this.deps.wiki.resolveAsOf(wikiId, asOf)
    if (!resolved) throw new WikiConsoleError('invalid_args')
    const wiki = await this.deps.wikis.findByConnectorId(connector.id)
    const state = resolved.seq === 0 ? [] : await this.deps.history.stateAt(wikiId, connector.id, resolved.seq)
    const live = state.filter((row) => row.status !== 'archived' && row.status !== 'pending_approval' && !row.erasedAt && row.path)
    const at = resolved.at ?? (resolved.seq > 0 ? await this.deps.history.appliedAtForSeq(wikiId, resolved.seq) : null)
    const fullDays = wiki?.retentionFullDays ?? 90
    return {
      seq: resolved.seq,
      at: at?.toISOString() ?? null,
      latestSeq: await this.deps.history.latestSeq(wikiId),
      /** §5.3: a ritkítás miatt csak napi felbontás lehet. */
      thinned: !!at && at.getTime() < this.now().getTime() - fullDays * 86_400_000,
      pageCount: live.length,
      categories: groupWikiIndex(
        live.map((row) => ({ path: row.path!, title: row.title, summary: row.summary, category: row.category, type: row.type ?? 'entity' })),
      ).map((group) => ({
        category: group.category,
        pages: group.pages.map((page) => ({ path: page.path, title: page.title, summary: page.summary, type: page.type })),
      })),
    }
  }

  async getPageAt(actor: WikiConsoleActor, connectorId: string, path: string, asOf: string) {
    const { connector, wikiId } = await this.open(actor, connectorId, 'view')
    const resolved = await this.deps.wiki.resolveAsOf(wikiId, asOf)
    if (!resolved) throw new WikiConsoleError('invalid_args')
    const state = resolved.seq === 0 ? [] : await this.deps.history.stateAt(wikiId, connector.id, resolved.seq)
    const row = state.find((candidate) => candidate.path === path.trim())
    if (!row || row.status === 'archived') throw new WikiConsoleError('not_found')
    return {
      seq: resolved.seq,
      path: row.path!,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      erased: !!row.erasedAt,
      title: row.erasedAt ? '' : row.title,
      summary: row.erasedAt ? '' : row.summary,
      body: row.erasedAt ? '' : row.body,
      sources: row.erasedAt ? [] : readWikiSources(row.sourceRefs),
      knownPaths: state.filter((item) => item.status !== 'archived' && item.path).map((item) => item.path!),
    }
  }

  // -------------------------------------------------------------------------
  // Címkék (§5.5)

  async createTag(actor: WikiConsoleActor, connectorId: string, input: { seq: number; name: string; note?: string | null }) {
    const { connector, wikiId } = await this.open(actor, connectorId, 'view')
    if (!this.canTag(actor, connector)) throw new WikiConsoleError('forbidden')
    const name = input.name.trim().slice(0, 120)
    const latest = await this.deps.history.latestSeq(wikiId)
    if (!name || !Number.isInteger(input.seq) || input.seq < 1 || input.seq > latest) throw new WikiConsoleError('invalid_args')
    const tag = await this.deps.history.createTag({
      wikiId,
      name,
      note: input.note?.trim().slice(0, 500) || null,
      seq: input.seq,
      createdByUserId: actor.userId,
    })
    if (!tag) throw new WikiConsoleError('invalid_args')
    await this.audit(connector, actor, 'kb.wiki.tag.created', tag.id, { wikiId, tagId: tag.id, seq: tag.seq, name: tag.name })
    return { id: tag.id, name: tag.name, seq: tag.seq }
  }

  async deleteTag(actor: WikiConsoleActor, connectorId: string, tagId: string) {
    const { connector, wikiId } = await this.open(actor, connectorId, 'view')
    if (!this.canTag(actor, connector)) throw new WikiConsoleError('forbidden')
    const tag = await this.deps.history.deleteTag(wikiId, tagId)
    if (!tag) throw new WikiConsoleError('not_found')
    await this.audit(connector, actor, 'kb.wiki.tag.deleted', tag.id, { wikiId, tagId: tag.id, seq: tag.seq, name: tag.name })
    return { deleted: true }
  }

  // -------------------------------------------------------------------------
  // Megőrzés (§6, D1)

  async getRetention(actor: WikiConsoleActor, connectorId: string) {
    const { connector } = await this.open(actor, connectorId, 'manage')
    const wiki = await this.deps.wikis.findByConnectorId(connector.id)
    if (!wiki) throw new WikiConsoleError('not_found')
    return {
      retentionFullDays: wiki.retentionFullDays,
      retentionDeleteDays: wiki.retentionDeleteDays,
      fullOptions: [...WIKI_RETENTION_FULL_OPTIONS],
      deleteOptions: [...WIKI_RETENTION_DELETE_OPTIONS],
      keepLatest: WIKI_RETENTION_KEEP_LATEST,
    }
  }

  async updateRetention(
    actor: WikiConsoleActor,
    connectorId: string,
    input: { retentionFullDays: number; retentionDeleteDays: number | null },
  ) {
    const { connector, wikiId } = await this.open(actor, connectorId, 'manage')
    const full = input.retentionFullDays
    const del = input.retentionDeleteDays
    if (!(WIKI_RETENTION_FULL_OPTIONS as readonly number[]).includes(full)) throw new WikiConsoleError('invalid_args')
    if (del !== null && (!(WIKI_RETENTION_DELETE_OPTIONS as readonly number[]).includes(del) || del < full)) {
      throw new WikiConsoleError('invalid_args')
    }
    const before = await this.deps.wikis.findByConnectorId(connector.id)
    await this.deps.history.updateRetention(wikiId, { retentionFullDays: full, retentionDeleteDays: del })
    await this.audit(connector, actor, 'kb.wiki.retention.changed', wikiId, {
      wikiId,
      fromFullDays: before?.retentionFullDays ?? null,
      fromDeleteDays: before?.retentionDeleteDays ?? null,
      retentionFullDays: full,
      retentionDeleteDays: del,
    })
    return { retentionFullDays: full, retentionDeleteDays: del }
  }

  /** Napi takarító (a `ai-audit-retention` route hívja): wikinként ritkít, töröl, kiürít. */
  async sweepRetention(): Promise<{ wikis: number; thinned: number; deleted: number; changeSetsPruned: number }> {
    const now = this.now()
    const totals = { wikis: 0, thinned: 0, deleted: 0, changeSetsPruned: 0 }
    let afterId: string | undefined
    for (;;) {
      const batch = await this.deps.history.listWikisForRetention({ afterId, limit: 100 })
      if (batch.length === 0) break
      afterId = batch[batch.length - 1].id
      for (const wiki of batch) {
        const counts = await this.deps.history.sweepRetention({
          wikiId: wiki.id,
          fullBefore: new Date(now.getTime() - wiki.retentionFullDays * 86_400_000),
          deleteBefore: wiki.retentionDeleteDays === null ? null : new Date(now.getTime() - wiki.retentionDeleteDays * 86_400_000),
          keepLatest: WIKI_RETENTION_KEEP_LATEST,
          limit: WIKI_RETENTION_BATCH,
          now,
        })
        totals.wikis++
        totals.thinned += counts.thinned
        totals.deleted += counts.deleted
        totals.changeSetsPruned += counts.changeSetsPruned
        if (counts.thinned + counts.deleted + counts.changeSetsPruned === 0) continue
        const connector = await this.deps.connectors.findById(wiki.connectorId)
        if (!connector) continue
        await this.deps.audit.append(
          redactKbAuditForVisibility(connector, {
            actorType: 'system',
            actorId: null,
            agentVersion: null,
            action: 'kb.wiki.retention.swept',
            targetType: 'wiki',
            targetId: wiki.id,
            modelUsed: null,
            inputRef: null,
            outputRef: connector.id,
            policyDecision: 'deleted',
            metadata: { wikiId: wiki.id, connectorId: connector.id, ...counts },
            tenantId: connector.tenantId,
          }),
        )
      }
    }
    return totals
  }

  // -------------------------------------------------------------------------
  // GDPR-törlés (§7, D9, D10)

  /**
   * Előnézet: a találatok helyenként, a környező szöveggel (csak a jogosultnak —
   * közösnél tenant-admin, privátnál a tulajdonos). Írás nincs.
   */
  async previewErasure(actor: WikiConsoleActor, connectorId: string, scope: WikiErasureScopeInput) {
    const { connector, wikiId } = await this.open(actor, connectorId, 'manage')
    const plan = await this.planErasure(connector, wikiId, actor.userId, scope)
    return {
      kind: scope.kind,
      mode: scope.kind === 'text' ? scope.mode : 'erase',
      counts: plan.counts,
      locations: plan.locations,
      total: Object.values(plan.counts).reduce((sum, n) => sum + n, 0),
      wikiName: await this.deps.wikiConsole.displayName(connector),
    }
  }

  async executeErasure(
    actor: WikiConsoleActor,
    connectorId: string,
    input: { scope: WikiErasureScopeInput; reason: string; confirmName: string },
  ) {
    const { connector, wikiId } = await this.open(actor, connectorId, 'manage')
    const reason = input.reason.trim()
    if (reason.length < 3 || reason.length > 500) throw new WikiConsoleError('invalid_args')
    const name = await this.deps.wikiConsole.displayName(connector)
    if (input.confirmName.trim().toLowerCase() !== name.trim().toLowerCase()) throw new WikiConsoleError('invalid_args')
    const plan = await this.planErasure(connector, wikiId, actor.userId, input.scope)
    const total = Object.values(plan.counts).reduce((sum, n) => sum + n, 0)
    if (total === 0) throw new WikiConsoleError('not_found')
    const result = await this.deps.history.executeErasure({ ...plan.write, reason })
    if (!result.ok) return { ok: false as const, code: 'conflict' }
    const scope = plan.write.scope as Record<string, unknown>
    await this.audit(connector, actor, 'kb.wiki.erasure.executed', result.erasureId, {
      wikiId,
      erasureId: result.erasureId,
      kind: input.scope.kind,
      mode: input.scope.kind === 'text' ? input.scope.mode : 'erase',
      reason,
      ...(typeof scope.matchHash === 'string' ? { matchHash: scope.matchHash } : {}),
      ...(Array.isArray(scope.pageIds) ? { pageIds: scope.pageIds } : {}),
      ...(result.changeSetId ? { changeSetId: result.changeSetId, seq: result.seq } : {}),
      counts: result.counts,
      erasedHashes: plan.write.erasedHashes,
    }, 'wiki')
    return { ok: true as const, erasureId: result.erasureId, counts: result.counts }
  }

  private async planErasure(
    connector: Connector,
    wikiId: string,
    userId: string,
    scope: WikiErasureScopeInput,
  ): Promise<{
    counts: Record<WikiErasureLocation, number>
    locations: Array<{ where: WikiErasureLocation; label: string; snippet?: string }>
    write: Omit<WikiErasureWrite, 'reason'>
  }> {
    const counts: Record<WikiErasureLocation, number> = {
      page: 0,
      revision: 0,
      changeSet: 0,
      log: 0,
      document: 0,
      sourceFile: 0,
      chunk: 0,
      gatewayOperation: 0,
    }
    const locations: Array<{ where: WikiErasureLocation; label: string; snippet?: string }> = []
    const write: Omit<WikiErasureWrite, 'reason'> = {
      wikiId,
      connectorId: connector.id,
      requestedBy: userId,
      scope: {},
      appliedAt: this.now(),
      tombstoneRevisionIds: [],
      tombstonePaths: {},
      redactRevisions: [],
      pageWrites: [],
      pageSummary: [],
      log: { title: 'Adatvédelmi törlés', note: null, actorUserId: userId },
      changeSets: [],
      logEntries: [],
      documents: { redact: [], delete: [] },
      chunkPattern: null,
      gatewayOperations: [],
      erasedHashes: [],
    }
    const addPageWrite = (page: WikiPage, state: WikiPageState, status: 'published' | 'archived') => {
      write.pageWrites.push({
        pageId: page.id,
        expectedVersion: page.version,
        previousPath: page.path,
        page: {
          path: state.path,
          type: state.type as WikiPage['type'],
          title: state.title,
          summary: state.summary,
          category: state.category,
          frontmatter: state.frontmatter as Prisma.InputJsonValue,
          body: state.body,
          sourceRefs: state.sources as unknown as Prisma.InputJsonValue,
          outLinks: [],
          status,
          contentHash: wikiPageContentHash(state),
        },
        chunks: status === 'archived' ? [] : pageChunks(state),
      })
      const before = diffLines(page.body, state.body)
      write.pageSummary.push({
        path: state.path,
        ...(page.path !== state.path ? { fromPath: null } : {}),
        action: status === 'archived' ? 'archived' : 'updated',
        title: state.title,
        linesAdded: before.filter((row) => row.kind === 'add').length,
        linesRemoved: before.filter((row) => row.kind === 'del').length,
      })
    }

    if (scope.kind === 'text') {
      const phrase = scope.phrase.trim()
      if (phrase.length < WIKI_ERASURE_MIN_PHRASE || phrase.length > 200) throw new WikiConsoleError('invalid_args')
      const salt = randomBytes(16).toString('hex')
      write.scope = {
        kind: 'text',
        mode: scope.mode,
        salt,
        matchHash: createHash('sha256').update(`${salt}:${phrase.toLowerCase()}`).digest('hex'),
      }
      const pattern = new RegExp(escapeRegExp(phrase), 'gi')
      const redact = (text: string) => text.replace(pattern, WIKI_ERASURE_MARK)
      const matches = await this.deps.history.findTextMatches(wikiId, connector.id, phrase)
      const pathMap = new Map<string, string>()
      for (const page of matches.pages) {
        const newPath = page.path.toLowerCase().includes(phrase.toLowerCase()) ? erasedPath(page.id) : page.path
        if (newPath !== page.path) pathMap.set(page.path, newPath)
        const state: WikiPageState = {
          path: newPath,
          type: page.type as WikiPageTypeName,
          title: redact(page.title),
          summary: redact(page.summary),
          category: page.category ? redact(page.category) : null,
          frontmatter: deepRedact(stripManagedFrontmatter(page.frontmatter), pattern) as Record<string, unknown>,
          body: redact(page.body),
          sources: readWikiSources(deepRedact(page.sourceRefs, pattern)),
        }
        addPageWrite(page, state, page.status === 'archived' ? 'archived' : 'published')
        counts.page++
        locations.push({ where: 'page', label: page.path, snippet: snippetOf(`${page.title}\n${page.summary}\n${page.body}`, phrase) })
      }
      for (const rev of matches.revisions) {
        counts.revision++
        locations.push({ where: 'revision', label: `${rev.path ?? ''} v${rev.version}`, snippet: snippetOf(`${rev.title}\n${rev.body}`, phrase) })
        if (scope.mode === 'erase') {
          write.tombstoneRevisionIds.push(rev.id)
          write.erasedHashes.push(rev.contentHash)
          if (rev.path && pathMap.has(rev.path)) write.tombstonePaths![rev.id] = pathMap.get(rev.path)!
          continue
        }
        const state: Omit<WikiPageState, 'path'> = {
          type: (rev.type ?? 'entity') as WikiPageTypeName,
          title: redact(rev.title),
          summary: redact(rev.summary),
          category: rev.category ? redact(rev.category) : null,
          frontmatter: deepRedact(stripManagedFrontmatter(rev.frontmatter), pattern) as Record<string, unknown>,
          body: redact(rev.body),
          sources: readWikiSources(deepRedact(rev.sourceRefs, pattern)),
        }
        write.redactRevisions.push({
          id: rev.id,
          title: state.title,
          summary: state.summary,
          body: state.body,
          category: state.category,
          sourceRefs: state.sources as unknown as Prisma.InputJsonValue,
          frontmatter: state.frontmatter as Prisma.InputJsonValue,
          contentHash: wikiPageContentHash(state),
          ...(rev.path && rev.path.toLowerCase().includes(phrase.toLowerCase()) ? { path: pathMap.get(rev.path) ?? erasedPath(rev.pageId) } : {}),
        })
      }
      for (const row of matches.changeSets) {
        counts.changeSet++
        locations.push({ where: 'changeSet', label: row.seq ? `#${row.seq}` : 'pending', snippet: snippetOf(JSON.stringify(row.pages), phrase) })
        if (scope.mode === 'erase') {
          // Teljes törlés: a sír-jeles verzió másolata ne maradjon a pages JSON-ban,
          // és a függő restore/upsert ne legyen újra alkalmazható (különben a kifejezés
          // nélküli személyes adat visszatérhetne a live wikibe).
          write.changeSets.push({
            id: row.id,
            pages: stripPhraseCopies(row.pages, pattern, pathMap) as Prisma.InputJsonValue,
            ...(row.pageSummary ? { pageSummary: deepRedact(row.pageSummary, pattern) as Prisma.InputJsonValue } : {}),
            logEntry: { op: (row.logEntry as { op?: string } | null)?.op ?? 'note', title: WIKI_ERASURE_MARK },
            validation: {},
            reject: row.status === 'pending',
          })
        } else {
          write.changeSets.push({
            id: row.id,
            pages: deepRedact(row.pages, pattern) as Prisma.InputJsonValue,
            ...(row.pageSummary ? { pageSummary: deepRedact(row.pageSummary, pattern) as Prisma.InputJsonValue } : {}),
            ...(row.logEntry ? { logEntry: deepRedact(row.logEntry, pattern) as Prisma.InputJsonValue } : {}),
            ...(row.validation ? { validation: deepRedact(row.validation, pattern) as Prisma.InputJsonValue } : {}),
          })
        }
      }
      for (const entry of matches.logEntries) {
        counts.log++
        locations.push({ where: 'log', label: entry.createdAt.toISOString().slice(0, 10), snippet: snippetOf(`${entry.title}\n${entry.note ?? ''}`, phrase) })
        write.logEntries.push({
          id: entry.id,
          title: redact(entry.title),
          note: entry.note ? redact(entry.note) : null,
          pagePaths: entry.pagePaths.map((path) => pathMap.get(path) ?? redact(path)),
        })
      }
      for (const doc of matches.documents) {
        counts.document++
        if (doc.hasSourceFile) counts.sourceFile++
        locations.push({ where: 'document', label: doc.filename, snippet: snippetOf(doc.extractedText ?? doc.filename, phrase) })
        if (scope.mode === 'erase') write.documents.delete.push(doc.id)
        else write.documents.redact.push({ id: doc.id, filename: redact(doc.filename), extractedText: doc.extractedText ? redact(doc.extractedText) : null })
      }
      if (matches.chunks > 0) {
        counts.chunk = matches.chunks
        locations.push({ where: 'chunk', label: String(matches.chunks) })
        write.chunkPattern = escapeRegExp(phrase)
      }
      for (const op of matches.gatewayOperations) {
        counts.gatewayOperation++
        locations.push({ where: 'gatewayOperation', label: op.id.slice(0, 8) })
        // Teljes törlésnél a gateway-kártya se őrizhet / futtathat másolatot.
        write.gatewayOperations.push(
          scope.mode === 'erase'
            ? { id: op.id, argsJson: {}, reject: true }
            : { id: op.id, argsJson: deepRedact(op.argsJson, pattern) as Prisma.InputJsonValue },
        )
      }
      return { counts, locations, write }
    }

    // Oldal- és verzió-mód: teljes törlés (sír-jel).
    const pages: WikiPage[] = []
    if (scope.kind === 'pages') {
      for (const path of [...new Set(scope.paths.map((item) => item.trim()))]) {
        const page = await this.deps.wikis.findPage(connector.id, path)
        if (!page) throw new WikiConsoleError('not_found')
        pages.push(page)
      }
      if (pages.length === 0 || pages.length > 50) throw new WikiConsoleError('invalid_args')
      write.scope = { kind: 'pages', pageIds: pages.map((page) => page.id) }
      const oldPaths = new Map<string, string>()
      const sourceIds = new Set<string>()
      for (const page of pages) {
        for (const source of readWikiSources(page.sourceRefs)) sourceIds.add(source.documentId)
        const newPath = erasedPath(page.id)
        const revisions = await this.deps.history.listRevisions(connector.id, page.id)
        for (const rev of revisions) {
          for (const source of readWikiSources(rev.sourceRefs)) sourceIds.add(source.documentId)
          if (rev.path) oldPaths.set(rev.path, newPath)
          if (rev.erasedAt) continue
          write.tombstoneRevisionIds.push(rev.id)
          write.tombstonePaths![rev.id] = newPath
          write.erasedHashes.push(rev.contentHash)
          counts.revision++
        }
        oldPaths.set(page.path, newPath)
        addPageWrite(
          page,
          {
            path: newPath,
            type: page.type as WikiPageTypeName,
            title: WIKI_ERASURE_MARK,
            summary: '',
            category: null,
            frontmatter: {},
            body: '',
            sources: [],
          },
          'archived',
        )
        counts.page++
        locations.push({ where: 'page', label: page.path })
      }
      for (const doc of await this.deps.history.listSourceDocuments(connector.id, [...sourceIds])) {
        write.documents.delete.push(doc.id)
        counts.document++
        if (doc.hasSourceFile) counts.sourceFile++
        locations.push({ where: 'document', label: doc.filename })
      }
      const pageIds = new Set(pages.map((page) => page.id))
      const changeSets = await this.deps.history.listPageChangeSets(wikiId, [...pageIds], [...oldPaths.keys()])
      const changeSetIds = new Set(changeSets.map((row) => row.id))
      for (const row of changeSets) {
        write.changeSets.push({
          id: row.id,
          pages: stripPagesJson(row.pages, oldPaths) as Prisma.InputJsonValue,
          pageSummary: readPageSummary(row.pageSummary).map((item) =>
            pageIds.has(item.pageId) ? { ...item, path: oldPaths.get(item.path) ?? item.path, title: WIKI_ERASURE_MARK, fromPath: null } : item,
          ) as unknown as Prisma.InputJsonValue,
          logEntry: { op: (row.logEntry as { op?: string } | null)?.op ?? 'note', title: WIKI_ERASURE_MARK },
          validation: {},
          reject: row.status === 'pending',
        })
        counts.changeSet++
      }
      for (const entry of await this.deps.history.listLogEntriesForPaths(wikiId, [...oldPaths.keys()])) {
        write.logEntries.push({
          id: entry.id,
          title: WIKI_ERASURE_MARK,
          note: null,
          pagePaths: entry.pagePaths.map((path) => oldPaths.get(path) ?? path),
        })
        counts.log++
      }
      for (const op of await this.deps.history.listPendingGatewayOperations(connector.id)) {
        const replaced = replacePaths(op.argsJson, oldPaths)
        const args = op.argsJson as { changeSetId?: string } | null
        if ((args?.changeSetId && changeSetIds.has(args.changeSetId)) || JSON.stringify(replaced) !== JSON.stringify(op.argsJson)) {
          // A régi javaslat nem alkalmazható újra, és az argumentuma sem őrizhet másolatot.
          write.gatewayOperations.push({ id: op.id, argsJson: {}, reject: true })
          counts.gatewayOperation++
        }
      }
      return { counts, locations, write }
    }

    // Egy kijelölt régi verzió.
    const page = await this.deps.wikis.findPage(connector.id, scope.path.trim())
    if (!page) throw new WikiConsoleError('not_found')
    const rev = await this.deps.history.findRevision(connector.id, page.id, scope.version)
    if (!rev || rev.erasedAt) throw new WikiConsoleError('not_found')
    // Az aktuális verzió nem lehet sír-jel: oldal-móddal vagy kifejezés-kitakarással törölhető.
    if (rev.version === page.version) throw new WikiConsoleError('invalid_args')
    write.scope = { kind: 'revision', pageId: page.id, revisionId: rev.id, version: rev.version }
    write.tombstoneRevisionIds.push(rev.id)
    write.erasedHashes.push(rev.contentHash)
    counts.revision = 1
    locations.push({ where: 'revision', label: `${page.path} v${rev.version}` })
    if (rev.changeSetId) {
      const changeSet = await this.deps.wikis.findChangeSet(rev.changeSetId)
      if (changeSet) {
        const paths = new Map([[rev.path ?? page.path, rev.path ?? page.path]])
        write.changeSets.push({ id: changeSet.id, pages: stripPagesJson(changeSet.pages, paths) as Prisma.InputJsonValue })
        counts.changeSet = 1
      }
    }
    return { counts, locations, write }
  }

  // -------------------------------------------------------------------------

  private async audit(
    connector: Connector,
    actor: WikiConsoleActor,
    action: string,
    targetId: string,
    metadata: Record<string, unknown>,
    targetType = 'wiki',
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
        policyDecision: action === 'kb.wiki.erasure.executed' ? 'deleted' : 'allowed',
        metadata: { ...metadata, userId: actor.userId, connectorId: connector.id },
        tenantId: actor.tenantId,
      }),
    )
  }
}

// ---------------------------------------------------------------------------

function changeRow(
  row: WikiChangeSet,
  author: Author,
  seqById: Map<string, number | null>,
) {
  const log = (row.logEntry ?? {}) as { op?: string; title?: string; note?: string | null }
  const pages = readPageSummary(row.pageSummary)
  return {
    seq: row.seq,
    status: row.status,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    author,
    op: log.op ?? null,
    title: log.title ?? null,
    note: log.note ?? null,
    revertsSeq: row.revertsId ? seqById.get(row.revertsId) ?? null : null,
    revertedBySeq: row.revertedById ? seqById.get(row.revertedById) ?? null : null,
    pages: pages.map((page: WikiChangeSetPageSummary) => ({
      path: page.path,
      action: page.action,
      title: page.title,
      linesAdded: page.linesAdded,
      linesRemoved: page.linesRemoved,
      fromPath: page.fromPath ?? null,
    })),
  }
}

/** Két revízió mezőnkénti és törzs-szintű eltérése (`before` nélkül: új oldal). */
function revisionDiff(before: WikiPageRevision | null, after: WikiPageRevision, page: WikiPage) {
  const sources = (rev: WikiPageRevision | null) =>
    rev ? readWikiSources(rev.sourceRefs ?? (rev.version === page.version ? page.sourceRefs : null)).map((ref) => ref.filename ?? ref.documentId).join(', ') : ''
  const field = (name: 'title' | 'summary' | 'path' | 'status' | 'category' | 'sources', a: string, b: string) =>
    a === b ? [] : [{ field: name, before: a, after: b }]
  return {
    fields: [
      ...field('title', before?.title ?? '', after.title),
      ...field('summary', before?.summary ?? '', after.summary),
      ...field('path', before?.path ?? '', after.path ?? ''),
      ...field('status', before?.status ?? '', after.status ?? ''),
      ...(before?.type === null || after.type === null ? [] : field('category', before?.category ?? '', after.category ?? '')),
      ...field('sources', sources(before), sources(after)),
    ],
    diff: diffLines(before?.body ?? '', after.body),
  }
}

function parseAuthorFilter(value: string | undefined): [string | undefined, string | undefined] {
  const match = /^(agent|user):([0-9a-f-]{36})$/i.exec(value ?? '')
  if (!match) return [undefined, undefined]
  return match[1] === 'agent' ? [match[2], undefined] : [undefined, match[2]]
}

function parseDay(value: string | undefined, edge: 'start' | 'end'): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const date = new Date(`${value}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Minden string-érték kitakarása egy JSON-fában (kulcsok változatlanok). */
export function deepRedact(value: unknown, pattern: RegExp): unknown {
  if (typeof value === 'string') return value.replace(pattern, WIKI_ERASURE_MARK)
  if (Array.isArray(value)) return value.map((item) => deepRedact(item, pattern))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, deepRedact(item, pattern)]))
  }
  return value
}

/** Change-set `pages` JSON: az érintett oldalak tartalma kiürül, csak az (új) útvonal és a művelet marad. */
function stripPagesJson(value: unknown, paths: Map<string, string>): unknown {
  if (!Array.isArray(value)) return value
  return value.map((item) => {
    if (!item || typeof item !== 'object') return item
    const row = item as Record<string, unknown>
    const path = typeof row.path === 'string' ? row.path : ''
    const newPath = typeof row.newPath === 'string' ? row.newPath : ''
    const restorePath = row.restore && typeof row.restore === 'object' ? String((row.restore as Record<string, unknown>).path ?? '') : ''
    if (!paths.has(path) && !paths.has(newPath) && !paths.has(restorePath)) return item
    return {
      path: paths.get(path) ?? path,
      action: row.action,
      ...(newPath ? { newPath: paths.get(newPath) ?? newPath } : {}),
      erased: true,
    }
  })
}

/**
 * Szöveges teljes törlés: a kifejezést tartalmazó pages-elemből a teljes tartalom
 * kiürül (nem csak a kifejezés cseréje) — így a sír-jeles verzió többi személyes
 * adata sem marad restore/upsert másolatban.
 */
function stripPhraseCopies(value: unknown, pattern: RegExp, paths: Map<string, string>): unknown {
  if (!Array.isArray(value)) return deepRedact(value, pattern)
  return value.map((item) => {
    if (!item || typeof item !== 'object') return item
    pattern.lastIndex = 0
    if (!pattern.test(JSON.stringify(item))) return item
    pattern.lastIndex = 0
    const row = item as Record<string, unknown>
    const path = typeof row.path === 'string' ? row.path : ''
    const newPath = typeof row.newPath === 'string' ? row.newPath : ''
    const scrub = (text: string) => {
      pattern.lastIndex = 0
      return text.replace(pattern, WIKI_ERASURE_MARK)
    }
    return {
      path: paths.get(path) ?? (path ? scrub(path) : path),
      action: row.action,
      ...(newPath ? { newPath: paths.get(newPath) ?? scrub(newPath) } : {}),
      erased: true,
    }
  })
}

function replacePaths(value: unknown, paths: Map<string, string>): unknown {
  if (typeof value === 'string') return paths.get(value) ?? value
  if (Array.isArray(value)) return value.map((item) => replacePaths(item, paths))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replacePaths(item, paths)]))
  }
  return value
}

function erasedPath(pageId: string): string {
  return `erased/${pageId.toLowerCase()}.md`
}

function snippetOf(text: string, phrase: string): string | undefined {
  const index = text.toLowerCase().indexOf(phrase.toLowerCase())
  if (index < 0) return undefined
  const start = Math.max(0, index - 60)
  const end = Math.min(text.length, index + phrase.length + 60)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`
}

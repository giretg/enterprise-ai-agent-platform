/**
 * #1129 wiki-kommentek. Az emberi műveletek a konzol `authorize` kapuján mennek át (élő hozzáférés:
 * más tenant, nem-tag admin, névsorról lekerült tag `not_found`), az agent-eszközök a `WikiService`
 * célfeloldásán. A szerző mindig a munkamenetből jön. A komment bizalmatlan adat: az agent válasza
 * is csak azt mondja meg neki, mit tehet ezzel a kommenttel, jogot nem ad.
 */
import type { Connector, WikiCommentEvent } from '@prisma/client'
import type { AuditRepository, WikiRepository } from '@/repositories/interfaces'
import type { WikiCommentRepository, WikiCommentRow, WikiCommentTodoRow } from '@/repositories/postgres/wiki-comment-repository'
import { redactKbAuditForVisibility } from '@/lib/audit/kb-private-redaction'
import { humanWikiAccess, ownerAgentIdForKnowledgeBase } from '@/lib/wiki-access'
import {
  WIKI_COMMENT_ACTIVE_STATUSES,
  WIKI_COMMENT_CLOSED_STATUSES,
  WIKI_COMMENT_MAX_AGENT_TEXT,
  WIKI_COMMENT_MAX_BODY,
  WIKI_COMMENT_MAX_QUOTE,
  WIKI_COMMENT_NOTICE,
  WIKI_COMMENT_RATE_LIMIT,
  WIKI_COMMENT_RATE_WINDOW_MS,
  WIKI_COMMENT_STATUSES,
  agentActionTarget,
  clampWikiCommentLimit,
  decodeWikiCommentCursor,
  encodeWikiCommentCursor,
  wikiCommentTextIsForbidden,
  type WikiCommentAgentAction,
  type WikiCommentStatusName,
} from '@/lib/wiki-comments'
import { wikiDisplayName, type WikiCaller, type WikiOutcome, type WikiService } from './wiki-service'
import { WikiConsoleError, type WikiConsoleActor, type WikiConsoleService } from './wiki-console-service'

export type WikiCommentErrorCode =
  | 'invalid_args'
  | 'comment_not_open'
  | 'comment_rate_limited'
  | 'comment_sensitive_data'
  | 'page_not_commentable'
  | 'not_author'

export class WikiCommentError extends Error {
  constructor(readonly code: WikiCommentErrorCode) {
    super(code)
    this.name = 'WikiCommentError'
  }
}

export type WikiCommentDeps = {
  comments: WikiCommentRepository
  wikis: Pick<WikiRepository, 'findPage'>
  wiki: Pick<WikiService, 'resolveTarget' | 'wikiIdForConnector'>
  wikiConsole: Pick<WikiConsoleService, 'authorize'>
  userLabels(ids: string[]): Promise<Map<string, string>>
  agentNames(tenantId: string, ids: string[]): Promise<Map<string, string>>
  audit: Pick<AuditRepository, 'append'>
  /** Az agent-eszközök a szerveren is `not_found`-ot adnak kikapcsolt flagnél (a chat nem az MCP-kapun jön). */
  commentsEnabled(tenantId: string): Promise<boolean>
  now?: () => Date
}

export type WikiCommentView = ReturnType<typeof commentView>

function cleanText(value: string, max: number): string {
  const text = value.trim()
  if (!text || text.length > max) throw new WikiCommentError('invalid_args')
  if (wikiCommentTextIsForbidden(text)) throw new WikiCommentError('comment_sensitive_data')
  return text
}

/** A szál sorai a felületnek: sima szöveg, a rendszer-bejegyzés gépi kóddal. */
function threadRows(events: WikiCommentEvent[], users: Map<string, string>, agents: Map<string, string>) {
  return events
    .filter((event) => event.kind === 'reply' || event.body || event.systemCode || event.erasedAt)
    .map((event) => ({
      id: event.id,
      kind: event.kind,
      actor: event.actorKind,
      actorName:
        event.actorKind === 'agent'
          ? agents.get(event.actorAgentId ?? '') ?? null
          : event.actorKind === 'human'
            ? users.get(event.actorUserId ?? '') ?? null
            : null,
      toStatus: event.toStatus,
      text: event.body,
      systemCode: event.systemCode,
      changeSetId: event.changeSetId,
      erased: !!event.erasedAt,
      at: event.createdAt.toISOString(),
    }))
}

function commentView(row: WikiCommentRow, users: Map<string, string>, agents: Map<string, string>, seqs: Map<string, number | null>) {
  return {
    id: row.id,
    path: row.page.path,
    pageTitle: row.page.title,
    pageStatus: row.page.status,
    pageVersionAtComment: row.pageVersion,
    currentPageVersion: row.page.version,
    pageChangedSinceComment: row.page.version !== row.pageVersion,
    quote: row.quote,
    body: row.body,
    status: row.status as WikiCommentStatusName,
    erased: !!row.erasedAt,
    author: { userId: row.authorUserId, name: users.get(row.authorUserId) ?? null },
    changeSeq: row.changeSetId ? seqs.get(row.changeSetId) ?? null : null,
    createdAt: row.createdAt.toISOString(),
    thread: threadRows(row.events, users, agents),
  }
}

function peopleOf(rows: WikiCommentRow[]) {
  return {
    userIds: [...new Set(rows.flatMap((row) => [row.authorUserId, ...row.events.map((event) => event.actorUserId).filter((id): id is string => !!id)]))],
    agentIds: [...new Set(rows.flatMap((row) => row.events.map((event) => event.actorAgentId).filter((id): id is string => !!id)))],
  }
}

const ROW_LIMIT = 200
const TODO_LIMIT = 100

export class WikiCommentService {
  constructor(private readonly deps: WikiCommentDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date()
  }

  private async open(actor: WikiConsoleActor, connectorId: string, need: 'view' | 'manage') {
    const { connector, access } = await this.deps.wikiConsole.authorize(actor, connectorId, need)
    return { connector, access }
  }

  private async views(tenantId: string, rows: WikiCommentRow[]) {
    const { userIds, agentIds } = peopleOf(rows)
    const [users, agents, seqs] = await Promise.all([
      this.deps.userLabels(userIds),
      this.deps.agentNames(tenantId, agentIds),
      this.deps.comments.changeSeqs([...new Set(rows.map((row) => row.changeSetId).filter((id): id is string => !!id))]),
    ])
    return rows.map((row) => commentView(row, users, agents, seqs))
  }

  // -------------------------------------------------------------------------
  // Ember (Control Plane)

  async addComment(actor: WikiConsoleActor, connectorId: string, input: { path: string; body: string; quote?: string | null }) {
    const { connector } = await this.open(actor, connectorId, 'view')
    const body = cleanText(input.body, WIKI_COMMENT_MAX_BODY)
    const quote = input.quote?.trim() ? cleanText(input.quote, WIKI_COMMENT_MAX_QUOTE) : null
    const page = await this.deps.wikis.findPage(connector.id, input.path.trim())
    // Csak élő oldalra: a generált lapok (`index.md`…) nem sorok, a jóváhagyásra váró és az archivált oldal nem feladat.
    if (!page || page.status !== 'published') throw new WikiCommentError('page_not_commentable')
    const now = this.now()
    const created = await this.deps.comments.create({
      wikiId: page.wikiId,
      connectorId: connector.id,
      pageId: page.id,
      pageVersion: page.version,
      quote,
      body,
      authorUserId: actor.userId,
      rateLimit: { max: WIKI_COMMENT_RATE_LIMIT, since: new Date(now.getTime() - WIKI_COMMENT_RATE_WINDOW_MS) },
    })
    if (!created.ok) throw new WikiCommentError('comment_rate_limited')
    await this.auditHuman(connector, actor, 'kb.wiki.comment.created', created.comment.id, {
      wikiId: page.wikiId,
      pageId: page.id,
      commentId: created.comment.id,
      status: 'open',
    })
    return { id: created.comment.id }
  }

  /** Egy oldal kommentjei: minden állapot, a törölt sír-jellel. */
  async listForPage(actor: WikiConsoleActor, connectorId: string, path: string) {
    const { connector, access } = await this.open(actor, connectorId, 'view')
    const page = await this.deps.wikis.findPage(connector.id, path.trim())
    if (!page) return { comments: [], canManage: access.manage, canComment: false, userId: actor.userId }
    const rows = await this.deps.comments.list({
      connectorId: connector.id,
      pageId: page.id,
      includeErased: true,
      includeArchivedPages: true,
      limit: ROW_LIMIT,
    })
    return {
      comments: await this.views(actor.tenantId, rows),
      canManage: access.manage,
      canComment: page.status === 'published',
      userId: actor.userId,
    }
  }

  /** A „Kommentek” fül: alapból minden nem lezárt komment, a legrégebbi elöl. */
  async listForWiki(
    actor: WikiConsoleActor,
    connectorId: string,
    filter: { status?: string; mine?: boolean; path?: string },
  ) {
    const { connector, access } = await this.open(actor, connectorId, 'view')
    const page = filter.path ? await this.deps.wikis.findPage(connector.id, filter.path.trim()) : null
    const statuses =
      filter.status === 'all'
        ? undefined
        : filter.status === 'closed'
          ? WIKI_COMMENT_CLOSED_STATUSES
          : (WIKI_COMMENT_STATUSES as readonly string[]).includes(filter.status ?? '')
            ? [filter.status as WikiCommentStatusName]
            : WIKI_COMMENT_ACTIVE_STATUSES
    const rows =
      filter.path && !page
        ? []
        : await this.deps.comments.list({
            connectorId: connector.id,
            ...(page ? { pageId: page.id } : {}),
            statuses,
            ...(filter.mine ? { authorUserId: actor.userId } : {}),
            includeErased: filter.status === 'all' || filter.status === 'closed',
            limit: ROW_LIMIT,
          })
    return { comments: await this.views(actor.tenantId, rows), canManage: access.manage, userId: actor.userId }
  }

  private async loadForHuman(connectorId: string, commentId: string) {
    const row = await this.deps.comments.findById(connectorId, commentId)
    if (!row || row.erasedAt) throw new WikiConsoleError('not_found')
    return row
  }

  async withdraw(actor: WikiConsoleActor, connectorId: string, commentId: string) {
    const { connector } = await this.open(actor, connectorId, 'view')
    const row = await this.loadForHuman(connector.id, commentId)
    if (row.authorUserId !== actor.userId) throw new WikiCommentError('not_author')
    const moved = await this.deps.comments.transition({
      id: commentId,
      connectorId: connector.id,
      from: ['open', 'question'],
      to: 'withdrawn',
      actor: { kind: 'human', userId: actor.userId },
      now: this.now(),
      authorSeen: true,
    })
    if (!moved) throw new WikiCommentError('comment_not_open')
    await this.auditHuman(connector, actor, 'kb.wiki.comment.withdrawn', commentId, { wikiId: row.wikiId, commentId, toStatus: 'withdrawn' })
    return { status: moved.status }
  }

  /** Válasz az agent kérdésére: bárki, aki látja a wikit; a komment újra az agentre vár. */
  async answer(actor: WikiConsoleActor, connectorId: string, commentId: string, text: string) {
    const { connector } = await this.open(actor, connectorId, 'view')
    const body = cleanText(text, WIKI_COMMENT_MAX_BODY)
    const row = await this.loadForHuman(connector.id, commentId)
    const moved = await this.deps.comments.answerQuestion({
      id: commentId,
      connectorId: connector.id,
      actor: { kind: 'human', userId: actor.userId },
      body,
      now: this.now(),
    })
    if (!moved) throw new WikiCommentError('comment_not_open')
    await this.auditHuman(connector, actor, 'kb.wiki.comment.replied', commentId, { wikiId: row.wikiId, commentId, toStatus: 'open' })
    return { status: moved.status }
  }

  /** Újranyitás indoklással: a szerző vagy a wiki-kezelő. Agent nem nyithat újra. */
  async reopen(actor: WikiConsoleActor, connectorId: string, commentId: string, reasonText: string) {
    const { connector, access } = await this.open(actor, connectorId, 'view')
    const body = cleanText(reasonText, WIKI_COMMENT_MAX_BODY)
    const row = await this.loadForHuman(connector.id, commentId)
    if (row.authorUserId !== actor.userId && !access.manage) throw new WikiCommentError('not_author')
    const moved = await this.deps.comments.transition({
      id: commentId,
      connectorId: connector.id,
      from: ['resolved', 'declined'],
      to: 'open',
      actor: { kind: 'human', userId: actor.userId },
      body,
      now: this.now(),
    })
    if (!moved) throw new WikiCommentError('comment_not_open')
    await this.auditHuman(connector, actor, 'kb.wiki.comment.reopened', commentId, { wikiId: row.wikiId, commentId, toStatus: 'open' })
    return { status: moved.status }
  }

  /** A kiút, ha az agent és a szerző nem jut dűlőre: a kezelő kézzel lezárja, indoklással. */
  async closeManually(actor: WikiConsoleActor, connectorId: string, commentId: string, input: { to: 'resolved' | 'declined'; reason: string }) {
    const { connector } = await this.open(actor, connectorId, 'manage')
    const body = cleanText(input.reason, WIKI_COMMENT_MAX_BODY)
    const row = await this.loadForHuman(connector.id, commentId)
    const moved = await this.deps.comments.transition({
      id: commentId,
      connectorId: connector.id,
      from: ['open', 'question'],
      to: input.to,
      actor: { kind: 'human', userId: actor.userId },
      body,
      now: this.now(),
      authorSeen: row.authorUserId === actor.userId,
    })
    if (!moved) throw new WikiCommentError('comment_not_open')
    await this.auditHuman(connector, actor, 'kb.wiki.comment.closed', commentId, { wikiId: row.wikiId, commentId, toStatus: input.to })
    return { status: moved.status }
  }

  /** Durva vagy téves tartalomhoz: a sor sír-jelként marad, a szöveg kiürül. */
  async remove(actor: WikiConsoleActor, connectorId: string, commentId: string) {
    const { connector } = await this.open(actor, connectorId, 'manage')
    const row = await this.loadForHuman(connector.id, commentId)
    const done = await this.deps.comments.tombstone({ id: commentId, connectorId: connector.id, now: this.now() })
    if (!done) throw new WikiCommentError('comment_not_open')
    await this.auditHuman(connector, actor, 'kb.wiki.comment.deleted', commentId, { wikiId: row.wikiId, commentId, status: row.status })
    return { removed: true }
  }

  // -------------------------------------------------------------------------
  // Teendők → Ami rád vár (D10): csak a szerzőnek, csak az aktív szervezetből, csak élő hozzáféréssel

  private canStillView(actor: WikiConsoleActor, connector: { visibility: string; ownerUserId: string | null; kbMemberUserIds: string[] }) {
    return humanWikiAccess({ userId: actor.userId, role: actor.role }, connector).view
  }

  /** A menü számlálója: csak számol, mert minden control-plane oldalon lefut. */
  async countTodos(actor: WikiConsoleActor): Promise<number> {
    const rows = await this.deps.comments.countTodoRows(actor.tenantId, actor.userId)
    return rows.filter((row) => this.canStillView(actor, row)).reduce((sum, row) => sum + row.count, 0)
  }

  async listTodos(actor: WikiConsoleActor) {
    const rows = await this.deps.comments.listTodoRows(actor.tenantId, actor.userId, TODO_LIMIT)
    const visible = rows.filter((row) => this.canStillView(actor, row.connector))
    const views = await this.views(actor.tenantId, visible)
    const ownerAgents = await this.deps.agentNames(
      actor.tenantId,
      visible.map((row) => ownerAgentIdForKnowledgeBase(row.connector.name)).filter((id): id is string => !!id),
    )
    const names = new Map(visible.map((row) => [row.id, this.todoWikiName(row, ownerAgents)]))
    return views.map((view, index) => {
      // A legutóbbi indokolt állapotváltás, bárki írta: a kézi lezárás indoka is ide tartozik, az ember válasza nem.
      const lastAnswer = [...view.thread].reverse().find((event) => event.kind === 'status' && event.text)
      return {
        ...view,
        connectorId: visible[index].connectorId,
        wikiName: names.get(view.id) ?? '',
        answer: lastAnswer?.text ?? null,
      }
    })
  }

  private todoWikiName(row: WikiCommentTodoRow, ownerAgents: Map<string, string>): string {
    const ownerAgent = ownerAgentIdForKnowledgeBase(row.connector.name)
    if (ownerAgent && ownerAgents.has(ownerAgent)) return ownerAgents.get(ownerAgent)!
    return wikiDisplayName({ name: row.connector.name, config: row.connector.config, visibility: row.connector.visibility as Connector['visibility'] })
  }

  /** „Rendben”: az állapot nem változik, csak a teendő tűnik el. */
  async acknowledge(actor: WikiConsoleActor, input: { commentId?: string; allResolved?: boolean }) {
    if (!input.commentId && !input.allResolved) throw new WikiCommentError('invalid_args')
    const count = await this.deps.comments.acknowledge({
      tenantId: actor.tenantId,
      authorUserId: actor.userId,
      ...(input.commentId ? { id: input.commentId } : { status: 'resolved' as const }),
      now: this.now(),
    })
    return { acknowledged: count }
  }

  // -------------------------------------------------------------------------
  // Agent (MCP)

  /** `kb_wiki_comments`: olvasás; alapból a nyitott, feldolgozásra váró kommentek, a legrégebbi elöl. */
  async listForAgent(
    caller: WikiCaller,
    input: { wikiId?: string; path?: string; commentId?: string; status?: string; limit?: number; cursor?: string },
  ): Promise<WikiOutcome> {
    if (!(await this.deps.commentsEnabled(caller.tenantId))) return { ok: false, code: 'not_found' }
    const target = await this.deps.wiki.resolveTarget(caller, input.wikiId, 'read')
    if ('ok' in target) return target
    const { connector } = target
    const limit = clampWikiCommentLimit(input.limit)
    const after = input.cursor ? decodeWikiCommentCursor(input.cursor) : undefined
    if (after === null) return { ok: false, code: 'invalid_args' }
    let pageId: string | undefined
    if (input.path) {
      const page = await this.deps.wikis.findPage(connector.id, input.path.trim())
      if (!page) return { ok: false, code: 'not_found' }
      pageId = page.id
    }
    const status = input.status ?? 'open'
    const statuses = status === 'all' ? undefined : [status as WikiCommentStatusName]
    const targeted = !!input.commentId
    const rows = await this.deps.comments.list({
      connectorId: connector.id,
      ...(pageId ? { pageId } : {}),
      ...(input.commentId ? { commentId: input.commentId } : {}),
      statuses: targeted ? undefined : statuses,
      includeArchivedPages: targeted || status !== 'open',
      after,
      limit: limit + 1,
    })
    if (input.commentId && rows.length === 0) return { ok: false, code: 'not_found' }
    const page = rows.slice(0, limit)
    const views = await this.views(caller.tenantId, page)
    const roles = await this.deps.comments.activeRoles(caller.tenantId, page.map((row) => row.authorUserId))
    const openTotal = (await this.deps.comments.countOpenByConnector([connector.id])).get(connector.id) ?? 0
    return {
      ok: true,
      result: {
        notice: WIKI_COMMENT_NOTICE,
        openTotal,
        comments: views.map((view, index) => {
          const role = roles.get(page[index].authorUserId)
          return {
            id: view.id,
            path: view.path,
            pageStatus: view.pageStatus,
            pageVersionAtComment: view.pageVersionAtComment,
            currentPageVersion: view.currentPageVersion,
            pageChangedSinceComment: view.pageChangedSinceComment,
            quote: view.quote,
            body: view.body,
            status: view.status,
            author: {
              name: view.author.name,
              isWikiManager: !!role && humanWikiAccess({ userId: view.author.userId, role }, connector).manage,
            },
            createdAt: view.createdAt,
            thread: view.thread.map((event) => ({
              kind: event.kind,
              actor: event.actor,
              ...(event.actorName ? { name: event.actorName } : {}),
              ...(event.toStatus ? { status: event.toStatus } : {}),
              ...(event.text ? { text: event.text } : {}),
              ...(event.systemCode ? { reasonCode: event.systemCode } : {}),
              at: event.at,
            })),
          }
        }),
        nextCursor: rows.length > limit ? encodeWikiCommentCursor(page[page.length - 1]) : null,
      },
    }
  }

  /** `kb_wiki_comment_respond`: oldalmódosítás nélküli lezárás vagy kérdés. Jóváhagyást nem igényel. */
  async respondAsAgent(
    caller: WikiCaller,
    input: { wikiId?: string; commentId: string; action: WikiCommentAgentAction; text: string },
  ): Promise<WikiOutcome> {
    if (!(await this.deps.commentsEnabled(caller.tenantId))) return { ok: false, code: 'not_found' }
    const target = await this.deps.wiki.resolveTarget(caller, input.wikiId, 'write')
    if ('ok' in target) return target
    const { connector, wikiId } = target
    const text = input.text.trim()
    if (!text || text.length > WIKI_COMMENT_MAX_AGENT_TEXT) return { ok: false, code: 'invalid_args' }
    if (wikiCommentTextIsForbidden(text)) return { ok: false, code: 'comment_sensitive_data' }
    const row = await this.deps.comments.findById(connector.id, input.commentId)
    if (!row || row.erasedAt) return { ok: false, code: 'not_found' }
    const to = agentActionTarget(input.action)
    const moved = await this.deps.comments.transition({
      id: input.commentId,
      connectorId: connector.id,
      from: ['open'],
      to,
      actor: { kind: 'agent', userId: caller.userId, agentId: caller.agentId },
      body: text,
      now: this.now(),
    })
    if (!moved) return { ok: false, code: 'comment_not_open' }
    await this.deps.audit.append(
      redactKbAuditForVisibility(connector, {
        actorType: 'agent',
        actorId: caller.agentId,
        agentVersion: null,
        action: 'kb.wiki.comment.responded',
        targetType: 'wiki_comment',
        targetId: input.commentId,
        modelUsed: null,
        inputRef: null,
        outputRef: connector.id,
        policyDecision: 'allowed',
        metadata: { wikiId, commentId: input.commentId, action: input.action, toStatus: to, agentId: caller.agentId, userId: caller.userId, connectorId: connector.id },
        tenantId: caller.tenantId,
      }),
    )
    return { ok: true, result: { wikiId, commentId: input.commentId, status: moved.status } }
  }

  private async auditHuman(connector: Connector, actor: WikiConsoleActor, action: string, targetId: string, metadata: Record<string, unknown>) {
    // S9: csak azonosító és állapot; S5: az átvett munkamenet látszik.
    await this.deps.audit.append(
      redactKbAuditForVisibility(connector, {
        actorType: 'human',
        actorId: actor.userId,
        agentVersion: null,
        action,
        targetType: 'wiki_comment',
        targetId,
        modelUsed: null,
        inputRef: null,
        outputRef: connector.id,
        policyDecision: 'allowed',
        metadata: { ...metadata, userId: actor.userId, connectorId: connector.id, ...(actor.assumed ? { assumed: true } : {}) },
        tenantId: actor.tenantId,
      }),
    )
  }
}

/**
 * #1129 wiki-kommentek tárolása. Jogosultságot nem dönt: azt a `WikiCommentService` végzi.
 * Az állapotváltás mindig feltételes (`from`), így két párhuzamos lezárásból csak egy nyer (AC11).
 * A `…InTx` függvényeket a wiki-írás és a GDPR-törlés a saját tranzakciójában hívja (NFR-4).
 */
import { Prisma, type WikiComment, type WikiCommentEvent, type WikiCommentStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import { WIKI_COMMENT_PARTLY_APPLIED, WikiCommentNotOpenError, type WikiCommentLink } from '@/lib/wiki-comments'

export type WikiCommentActor = { kind: 'human' | 'agent' | 'system'; userId?: string | null; agentId?: string | null }

export type WikiCommentPageRef = { id: string; path: string; title: string; status: string; version: number }

export type WikiCommentRow = WikiComment & { page: WikiCommentPageRef; events: WikiCommentEvent[] }

export type WikiCommentListFilter = {
  connectorId: string
  pageId?: string
  commentId?: string
  statuses?: readonly WikiCommentStatus[]
  authorUserId?: string
  /** Az archivált oldal kommentje nem feladat, csak célzott lekérdezésben látszik. */
  includeArchivedPages?: boolean
  includeErased?: boolean
  after?: { createdAt: Date; id: string }
  limit?: number
}

export type WikiCommentTodoRow = WikiCommentRow & {
  connector: { id: string; name: string; config: Prisma.JsonValue; visibility: string; ownerUserId: string | null; kbMemberUserIds: string[] }
}

export type WikiCommentTodoCount = {
  connectorId: string
  visibility: string
  ownerUserId: string | null
  kbMemberUserIds: string[]
  count: number
}

export type WikiCommentForWrite = {
  id: string
  status: WikiCommentStatus
  authorUserId: string
  createdAt: Date
  erasedAt: Date | null
  /** Akik az agent kérdésére válaszoltak: a kérdéskörben bárki, aki látja a wikit (D3). */
  replierUserIds: string[]
}

export type WikiCommentErasure = {
  erase: string[]
  redact: Array<{ id: string; body: string; quote: string | null; events: Array<{ id: string; body: string }> }>
  clearQuotes: string[]
}

export type WikiCommentTextMatch = {
  id: string
  pagePath: string
  body: string
  quote: string | null
  events: Array<{ id: string; body: string }>
}

export interface WikiCommentRepository {
  create(input: {
    wikiId: string
    connectorId: string
    pageId: string
    pageVersion: number
    quote: string | null
    body: string
    authorUserId: string
    rateLimit: { max: number; since: Date }
  }): Promise<{ ok: true; comment: WikiComment } | { ok: false; reason: 'rate_limited' }>
  findById(connectorId: string, id: string): Promise<WikiCommentRow | null>
  list(filter: WikiCommentListFilter): Promise<WikiCommentRow[]>
  countOpenByConnector(connectorIds: string[]): Promise<Map<string, number>>
  countOpenForPage(pageId: string): Promise<number>
  /** A láthatóság-előnézethez: minden nem törölt komment. */
  countForConnector(connectorId: string): Promise<number>
  transition(input: {
    id: string
    connectorId: string
    from: readonly WikiCommentStatus[]
    to: WikiCommentStatus
    actor: WikiCommentActor
    body?: string | null
    now: Date
    /** A szerző maga zárta le: nem keletkezik teendő. */
    authorSeen?: boolean
  }): Promise<WikiComment | null>
  /** Válasz a kérdésre: `question` → `open`, a válasz és az állapotváltás egy tranzakcióban. */
  answerQuestion(input: { id: string; connectorId: string; actor: WikiCommentActor; body: string; now: Date }): Promise<WikiComment | null>
  tombstone(input: { id: string; connectorId: string; now: Date }): Promise<boolean>
  acknowledge(input: { tenantId: string; authorUserId: string; id?: string; status?: 'resolved' | 'declined'; now: Date }): Promise<number>
  listTodoRows(tenantId: string, authorUserId: string, limit: number): Promise<WikiCommentTodoRow[]>
  countTodoRows(tenantId: string, authorUserId: string): Promise<WikiCommentTodoCount[]>
  activeRoles(tenantId: string, userIds: string[]): Promise<Map<string, string>>
  findForWrite(wikiId: string, ids: string[]): Promise<WikiCommentForWrite[]>
  /** A jóváhagyó kártyához és a változásnézethez: a módosítást kérő kommentek. */
  listForChangeSet(connectorId: string, changeSetId: string): Promise<WikiCommentRow[]>
  boundToChangeSet(changeSetId: string): Promise<string[]>
  /** A „Módosítás megnyitása” linkhez: az alkalmazott change-setek sorszáma. */
  changeSeqs(changeSetIds: string[]): Promise<Map<string, number | null>>
  resolvedCountsByChangeSet(changeSetIds: string[]): Promise<Map<string, number>>
  findTextMatches(wikiId: string, connectorId: string, phrase: string): Promise<WikiCommentTextMatch[]>
  listForPages(connectorId: string, pageIds: string[]): Promise<Array<{ id: string; pageId: string }>>
  listWithQuoteAt(connectorId: string, pageId: string, version: number): Promise<string[]>
}

const withPageAndEvents = {
  page: { select: { id: true, path: true, title: true, status: true, version: true } },
  events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.WikiCommentInclude

/** Lezárt állapot: a megőrzési idő indul. Újranyitás: tiszta lappal indul, a következő lezárás újra teendő. */
function statusPatch(to: WikiCommentStatus, now: Date): Prisma.WikiCommentUncheckedUpdateManyInput {
  if (to === 'resolved' || to === 'declined' || to === 'withdrawn') return { status: to, closedAt: now }
  if (to === 'open') return { status: to, closedAt: null, authorSeenAt: null, changeSetId: null }
  return { status: to }
}

function actorColumns(actor: WikiCommentActor) {
  return { actorKind: actor.kind, actorUserId: actor.userId ?? null, actorAgentId: actor.agentId ?? null }
}

/** Közvetlen írás: `open` → `resolved` a change-set tranzakciójában. Eltérésnél az egész írás visszagörgetődik. */
export async function closeLinkedCommentsInTx(
  tx: Prisma.TransactionClient,
  input: { connectorId: string; links: WikiCommentLink[]; changeSetId: string; actor: WikiCommentActor; now: Date },
): Promise<void> {
  for (const link of input.links) {
    const moved = await tx.wikiComment.updateMany({
      where: { id: link.commentId, connectorId: input.connectorId, status: 'open', erasedAt: null },
      data: { status: 'resolved', closedAt: input.now, changeSetId: input.changeSetId },
    })
    if (moved.count !== 1) throw new WikiCommentNotOpenError()
    await tx.wikiCommentEvent.create({
      data: {
        commentId: link.commentId,
        kind: 'status',
        fromStatus: 'open',
        toStatus: 'resolved',
        ...actorColumns(input.actor),
        body: link.note,
        changeSetId: input.changeSetId,
      },
    })
  }
}

/** Jóváhagyásos írás: `open` → `pending_approval`, a függő change-settel egy tranzakcióban. */
export async function bindLinkedCommentsInTx(
  tx: Prisma.TransactionClient,
  input: { connectorId: string; links: WikiCommentLink[]; changeSetId: string; actor: WikiCommentActor; partlyApplied: boolean },
): Promise<void> {
  for (const link of input.links) {
    const moved = await tx.wikiComment.updateMany({
      where: { id: link.commentId, connectorId: input.connectorId, status: 'open', erasedAt: null },
      data: { status: 'pending_approval', changeSetId: input.changeSetId },
    })
    if (moved.count !== 1) throw new WikiCommentNotOpenError()
    await tx.wikiCommentEvent.create({
      data: {
        commentId: link.commentId,
        kind: 'status',
        fromStatus: 'open',
        toStatus: 'pending_approval',
        ...actorColumns(input.actor),
        body: link.note,
        systemCode: input.partlyApplied ? WIKI_COMMENT_PARTLY_APPLIED : null,
        changeSetId: input.changeSetId,
      },
    })
  }
}

/** Jóváhagyáskor a hozzá kötött kommentek készek. Visszaadja, melyek. */
export async function resolveBoundCommentsInTx(
  tx: Prisma.TransactionClient,
  input: { changeSetId: string; now: Date },
): Promise<string[]> {
  const rows = await tx.wikiComment.findMany({
    where: { changeSetId: input.changeSetId, status: 'pending_approval' },
    select: { id: true },
  })
  for (const { id } of rows) {
    await tx.wikiComment.update({ where: { id }, data: { status: 'resolved', closedAt: input.now } })
    await tx.wikiCommentEvent.create({
      data: {
        commentId: id,
        kind: 'status',
        fromStatus: 'pending_approval',
        toStatus: 'resolved',
        actorKind: 'system',
        changeSetId: input.changeSetId,
      },
    })
  }
  return rows.map((row) => row.id)
}

/**
 * Elutasítás, ütközés, teljes visszavonás, törlés: a hozzá kötött kommentek visszanyílnak, a rendszer-
 * bejegyzésből az agent és az ember is látja, miért. Vegyes írásnál a kód jelzi, hogy egy rész élesben maradt.
 */
export async function reopenBoundCommentsInTx(
  tx: Prisma.TransactionClient,
  input: { changeSetId: string; from: 'pending_approval' | 'resolved'; systemCode: string; body?: string | null; actor?: WikiCommentActor; now: Date },
): Promise<string[]> {
  const rows = await tx.wikiComment.findMany({
    where: { changeSetId: input.changeSetId, status: input.from },
    select: { id: true },
  })
  for (const { id } of rows) {
    const partly =
      input.from === 'pending_approval'
        ? await tx.wikiCommentEvent.count({ where: { commentId: id, changeSetId: input.changeSetId, systemCode: WIKI_COMMENT_PARTLY_APPLIED } })
        : 0
    await tx.wikiComment.update({ where: { id }, data: statusPatch('open', input.now) as Prisma.WikiCommentUncheckedUpdateInput })
    await tx.wikiCommentEvent.create({
      data: {
        commentId: id,
        kind: 'status',
        fromStatus: input.from,
        toStatus: 'open',
        ...actorColumns(input.actor ?? { kind: 'system' }),
        body: input.body ?? null,
        systemCode: partly ? `${input.systemCode}_${WIKI_COMMENT_PARTLY_APPLIED}` : input.systemCode,
        changeSetId: input.changeSetId,
      },
    })
  }
  return rows.map((row) => row.id)
}

/** A sor sír-jelként marad, a szöveg kiürül; a szál szövege is. */
export async function eraseCommentsInTx(
  tx: Prisma.TransactionClient,
  input: { connectorId: string; ids: string[]; now: Date; erasureId?: string | null },
): Promise<number> {
  if (input.ids.length === 0) return 0
  const erased = await tx.wikiComment.updateMany({
    where: { id: { in: input.ids }, connectorId: input.connectorId, erasedAt: null },
    data: { body: '', quote: null, erasedAt: input.now, erasureId: input.erasureId ?? null },
  })
  await tx.wikiCommentEvent.updateMany({
    where: { commentId: { in: input.ids }, comment: { connectorId: input.connectorId } },
    data: { body: null, erasedAt: input.now },
  })
  return erased.count
}

/** GDPR: teljes törlés, kifejezés-kitakarás, illetve a törölt revízióból származó idézetek ürítése. */
export async function applyCommentErasureInTx(
  tx: Prisma.TransactionClient,
  input: { connectorId: string; erasure: WikiCommentErasure; erasureId: string; now: Date },
): Promise<number> {
  let affected = await eraseCommentsInTx(tx, {
    connectorId: input.connectorId,
    ids: input.erasure.erase,
    now: input.now,
    erasureId: input.erasureId,
  })
  for (const row of input.erasure.redact) {
    const redacted = await tx.wikiComment.updateMany({
      where: { id: row.id, connectorId: input.connectorId, erasedAt: null },
      data: { body: row.body, quote: row.quote, erasureId: input.erasureId },
    })
    affected += redacted.count
    for (const event of row.events) {
      await tx.wikiCommentEvent.updateMany({
        where: { id: event.id, commentId: row.id },
        data: { body: event.body },
      })
    }
  }
  if (input.erasure.clearQuotes.length > 0) {
    const cleared = await tx.wikiComment.updateMany({
      where: { id: { in: input.erasure.clearQuotes }, connectorId: input.connectorId },
      data: { quote: null, erasureId: input.erasureId },
    })
    affected += cleared.count
  }
  return affected
}

/** Napi megőrzés (D11): a lezárt komment a `closedAt`-től számítva ürül. */
export async function sweepClosedCommentsInTx(
  tx: Prisma.TransactionClient,
  input: { wikiId: string; connectorId: string; before: Date; limit: number; now: Date },
): Promise<number> {
  const rows = await tx.wikiComment.findMany({
    where: {
      wikiId: input.wikiId,
      connectorId: input.connectorId,
      erasedAt: null,
      status: { in: ['resolved', 'declined', 'withdrawn'] },
      closedAt: { lt: input.before },
    },
    select: { id: true },
    orderBy: { closedAt: 'asc' },
    take: input.limit,
  })
  return eraseCommentsInTx(tx, { connectorId: input.connectorId, ids: rows.map((row) => row.id), now: input.now })
}

export class PostgresWikiCommentRepository implements WikiCommentRepository {
  async create(input: Parameters<WikiCommentRepository['create']>[0]): ReturnType<WikiCommentRepository['create']> {
    return prisma.$transaction(async (tx) => {
      // Szerzőnként és wikinként sorba állítva, így a 31. komment párhuzamos küldésnél sem csúszik át.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wiki-comment:${input.wikiId}:${input.authorUserId}`}))`
      const recent = await tx.wikiComment.count({
        where: { wikiId: input.wikiId, authorUserId: input.authorUserId, createdAt: { gte: input.rateLimit.since } },
      })
      if (recent >= input.rateLimit.max) return { ok: false as const, reason: 'rate_limited' as const }
      const comment = await tx.wikiComment.create({
        data: {
          wikiId: input.wikiId,
          connectorId: input.connectorId,
          pageId: input.pageId,
          pageVersion: input.pageVersion,
          quote: input.quote,
          body: input.body,
          authorUserId: input.authorUserId,
        },
      })
      return { ok: true as const, comment }
    })
  }

  findById(connectorId: string, id: string): Promise<WikiCommentRow | null> {
    return prisma.wikiComment.findFirst({ where: { id, connectorId }, include: withPageAndEvents })
  }

  list(filter: WikiCommentListFilter): Promise<WikiCommentRow[]> {
    return prisma.wikiComment.findMany({
      where: {
        connectorId: filter.connectorId,
        ...(filter.pageId ? { pageId: filter.pageId } : {}),
        ...(filter.commentId ? { id: filter.commentId } : {}),
        ...(filter.statuses ? { status: { in: [...filter.statuses] } } : {}),
        ...(filter.authorUserId ? { authorUserId: filter.authorUserId } : {}),
        ...(filter.includeErased ? {} : { erasedAt: null }),
        ...(filter.includeArchivedPages ? {} : { page: { status: { not: 'archived' } } }),
        ...(filter.after
          ? {
              OR: [
                { createdAt: { gt: filter.after.createdAt } },
                { createdAt: filter.after.createdAt, id: { gt: filter.after.id } },
              ],
            }
          : {}),
      },
      include: withPageAndEvents,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: filter.limit ?? 200,
    })
  }

  async countOpenByConnector(connectorIds: string[]): Promise<Map<string, number>> {
    if (connectorIds.length === 0) return new Map()
    const rows = await prisma.wikiComment.groupBy({
      by: ['connectorId'],
      where: { connectorId: { in: connectorIds }, status: 'open', erasedAt: null, page: { status: { not: 'archived' } } },
      _count: { _all: true },
    })
    return new Map(rows.map((row) => [row.connectorId, row._count._all]))
  }

  countOpenForPage(pageId: string): Promise<number> {
    return prisma.wikiComment.count({ where: { pageId, status: 'open', erasedAt: null, page: { status: { not: 'archived' } } } })
  }

  countForConnector(connectorId: string): Promise<number> {
    return prisma.wikiComment.count({ where: { connectorId, erasedAt: null } })
  }

  async transition(input: Parameters<WikiCommentRepository['transition']>[0]): Promise<WikiComment | null> {
    return prisma.$transaction(async (tx) => {
      const current = await tx.wikiComment.findFirst({
        where: { id: input.id, connectorId: input.connectorId, status: { in: [...input.from] }, erasedAt: null },
        select: { status: true },
      })
      if (!current) return null
      const moved = await tx.wikiComment.updateMany({
        where: { id: input.id, status: current.status, erasedAt: null },
        data: { ...statusPatch(input.to, input.now), ...(input.authorSeen ? { authorSeenAt: input.now } : {}) },
      })
      if (moved.count !== 1) return null
      await tx.wikiCommentEvent.create({
        data: {
          commentId: input.id,
          kind: 'status',
          fromStatus: current.status,
          toStatus: input.to,
          ...actorColumns(input.actor),
          body: input.body ?? null,
        },
      })
      return tx.wikiComment.findUnique({ where: { id: input.id } })
    })
  }

  async answerQuestion(input: Parameters<WikiCommentRepository['answerQuestion']>[0]): Promise<WikiComment | null> {
    return prisma.$transaction(async (tx) => {
      const moved = await tx.wikiComment.updateMany({
        where: { id: input.id, connectorId: input.connectorId, status: 'question', erasedAt: null },
        data: statusPatch('open', input.now),
      })
      if (moved.count !== 1) return null
      await tx.wikiCommentEvent.create({
        data: { commentId: input.id, kind: 'reply', ...actorColumns(input.actor), body: input.body },
      })
      await tx.wikiCommentEvent.create({
        data: { commentId: input.id, kind: 'status', fromStatus: 'question', toStatus: 'open', ...actorColumns(input.actor) },
      })
      return tx.wikiComment.findUnique({ where: { id: input.id } })
    })
  }

  async tombstone(input: Parameters<WikiCommentRepository['tombstone']>[0]): Promise<boolean> {
    return prisma.$transaction(
      async (tx) => (await eraseCommentsInTx(tx, { connectorId: input.connectorId, ids: [input.id], now: input.now })) === 1,
    )
  }

  async acknowledge(input: Parameters<WikiCommentRepository['acknowledge']>[0]): Promise<number> {
    const result = await prisma.wikiComment.updateMany({
      where: {
        authorUserId: input.authorUserId,
        authorSeenAt: null,
        erasedAt: null,
        connector: { tenantId: input.tenantId },
        ...(input.id ? { id: input.id } : {}),
        status: input.status ?? { in: ['resolved', 'declined'] },
      },
      data: { authorSeenAt: input.now },
    })
    return result.count
  }

  /** `decision`: a szerző döntésére vár, ez a számláló; `info`: kész, csak tájékoztatás. */
  private todoWhere(tenantId: string, authorUserId: string, kind: 'decision' | 'info'): Prisma.WikiCommentWhereInput {
    return {
      authorUserId,
      erasedAt: null,
      connector: { tenantId, lifecycleState: 'active', type: 'knowledge_base' },
      page: { status: { not: 'archived' } },
      OR: kind === 'decision'
        ? [{ status: 'question' }, { status: 'declined', authorSeenAt: null }]
        : [{ status: 'resolved', authorSeenAt: null }],
    }
  }

  /** A döntést váró sorok előbb, hogy a sok „Beledolgozva” ne szoríthassa ki őket: a szám és a sorok egyeznek (AC21). */
  async listTodoRows(tenantId: string, authorUserId: string, limit: number): Promise<WikiCommentTodoRow[]> {
    const query = (where: Prisma.WikiCommentWhereInput, take: number) =>
      prisma.wikiComment.findMany({
        where,
        include: {
          ...withPageAndEvents,
          connector: { select: { id: true, name: true, config: true, visibility: true, ownerUserId: true, kbMemberUserIds: true } },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take,
      })
    const decisions = await query(this.todoWhere(tenantId, authorUserId, 'decision'), limit)
    if (decisions.length >= limit) return decisions
    return [...decisions, ...(await query(this.todoWhere(tenantId, authorUserId, 'info'), limit - decisions.length))]
  }

  async countTodoRows(tenantId: string, authorUserId: string): Promise<WikiCommentTodoCount[]> {
    const groups = await prisma.wikiComment.groupBy({
      by: ['connectorId'],
      where: this.todoWhere(tenantId, authorUserId, 'decision'),
      _count: { _all: true },
    })
    if (groups.length === 0) return []
    const connectors = await prisma.connector.findMany({
      where: { id: { in: groups.map((row) => row.connectorId) } },
      select: { id: true, visibility: true, ownerUserId: true, kbMemberUserIds: true },
    })
    const counts = new Map(groups.map((row) => [row.connectorId, row._count._all]))
    return connectors.map((row) => ({
      connectorId: row.id,
      visibility: row.visibility,
      ownerUserId: row.ownerUserId,
      kbMemberUserIds: row.kbMemberUserIds,
      count: counts.get(row.id) ?? 0,
    }))
  }

  async activeRoles(tenantId: string, userIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)]
    if (unique.length === 0) return new Map()
    const rows = await prisma.tenantMembership.findMany({
      where: { tenantId, status: 'active', userId: { in: unique } },
      select: { userId: true, role: true },
    })
    return new Map(rows.map((row) => [row.userId, row.role]))
  }

  async findForWrite(wikiId: string, ids: string[]): Promise<WikiCommentForWrite[]> {
    if (ids.length === 0) return []
    const rows = await prisma.wikiComment.findMany({
      where: { wikiId, id: { in: ids } },
      select: {
        id: true,
        status: true,
        authorUserId: true,
        createdAt: true,
        erasedAt: true,
        events: { where: { kind: 'reply', erasedAt: null, actorUserId: { not: null } }, select: { actorUserId: true } },
      },
    })
    return rows.map(({ events, ...row }) => ({
      ...row,
      replierUserIds: events.map((event) => event.actorUserId).filter((id): id is string => !!id),
    }))
  }

  listForChangeSet(connectorId: string, changeSetId: string): Promise<WikiCommentRow[]> {
    return prisma.wikiComment.findMany({
      where: { connectorId, OR: [{ changeSetId }, { events: { some: { changeSetId } } }] },
      include: withPageAndEvents,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 50,
    })
  }

  async boundToChangeSet(changeSetId: string): Promise<string[]> {
    const rows = await prisma.wikiComment.findMany({
      where: { changeSetId, status: 'pending_approval' },
      select: { id: true },
    })
    return rows.map((row) => row.id)
  }

  async changeSeqs(changeSetIds: string[]): Promise<Map<string, number | null>> {
    if (changeSetIds.length === 0) return new Map()
    const rows = await prisma.wikiChangeSet.findMany({ where: { id: { in: changeSetIds } }, select: { id: true, seq: true } })
    return new Map(rows.map((row) => [row.id, row.seq]))
  }

  async resolvedCountsByChangeSet(changeSetIds: string[]): Promise<Map<string, number>> {
    if (changeSetIds.length === 0) return new Map()
    const rows = await prisma.wikiComment.groupBy({
      by: ['changeSetId'],
      where: { changeSetId: { in: changeSetIds }, status: 'resolved' },
      _count: { _all: true },
    })
    return new Map(rows.map((row) => [row.changeSetId!, row._count._all]))
  }

  async findTextMatches(wikiId: string, connectorId: string, phrase: string): Promise<WikiCommentTextMatch[]> {
    const needle = phrase.toLowerCase()
    const ids = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT c.id FROM wiki_comments c
      WHERE c.wiki_id = ${wikiId}::uuid AND c.connector_id = ${connectorId}::uuid AND c.erased_at IS NULL
        AND (position(${needle} in lower(c.body)) > 0
          OR position(${needle} in lower(COALESCE(c.quote, ''))) > 0
          OR EXISTS (
            SELECT 1 FROM wiki_comment_events e
            WHERE e.comment_id = c.id AND position(${needle} in lower(COALESCE(e.body, ''))) > 0
          ))`)
    if (ids.length === 0) return []
    const rows = await prisma.wikiComment.findMany({
      where: { id: { in: ids.map((row) => row.id) } },
      select: {
        id: true,
        body: true,
        quote: true,
        page: { select: { path: true } },
        events: { where: { body: { not: null } }, select: { id: true, body: true } },
      },
    })
    return rows.map((row) => ({
      id: row.id,
      pagePath: row.page.path,
      body: row.body,
      quote: row.quote,
      events: row.events.map((event) => ({ id: event.id, body: event.body ?? '' })),
    }))
  }

  listForPages(connectorId: string, pageIds: string[]): Promise<Array<{ id: string; pageId: string }>> {
    if (pageIds.length === 0) return Promise.resolve([])
    return prisma.wikiComment.findMany({
      where: { connectorId, pageId: { in: pageIds }, erasedAt: null },
      select: { id: true, pageId: true },
    })
  }

  async listWithQuoteAt(connectorId: string, pageId: string, version: number): Promise<string[]> {
    const rows = await prisma.wikiComment.findMany({
      where: { connectorId, pageId, pageVersion: version, quote: { not: null }, erasedAt: null },
      select: { id: true },
    })
    return rows.map((row) => row.id)
  }
}

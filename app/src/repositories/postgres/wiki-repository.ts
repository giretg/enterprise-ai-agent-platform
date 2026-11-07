import { parseWikiReprocess } from '@/lib/wiki-access'
import { Prisma, type AgentWiki, type WikiChangeSet, type WikiPage } from '@prisma/client'
import { prisma } from '@/lib/db'
import { readKbPurpose } from '@/lib/kb-retrieval'
import { kbPgStemDict } from '@/lib/kb-language'
import { KB_FOLD_FROM, KB_FOLD_TO, kbLiteralPattern, kbTermNeedle, kbTermPattern, kbTextTerm } from '@/lib/kb-text-match'
import type {
  PrivateKnowledgeBasePurgeCounts,
  PrivateKnowledgeBaseRow,
  PrivateKnowledgeBaseStore,
  WikiInboxCounts,
  WikiInboxItem,
  WikiReprocessRequestResult,
  WikiApplyChangeSetInput,
  WikiApplyChangeSetResult,
  WikiApplyPageOp,
  WikiChangeSetPageSummary,
  WikiConfigApplyPlan,
  WikiConfigRepository,
  WikiInboxSummary,
  WikiPageSearchResult,
  WikiRepository,
  WikiStructureRepository,
} from '../interfaces'
import type { WikiCategoryRow } from '@/lib/wiki-categories'
import { configVersionOf, configPagesVersionOf, type WikiConfigState } from '@/lib/wiki-config'
import { metaFromColumns, type WikiFieldDef } from '@/lib/wiki-metadata'
import {
  bindLinkedCommentsInTx,
  closeLinkedCommentsInTx,
  reopenBoundCommentsInTx,
  resolveBoundCommentsInTx,
  type WikiCommentActor,
} from './wiki-comment-repository'
import { WikiCommentNotOpenError } from '@/lib/wiki-comments'
import type { WikiPageMetaQuery, WikiPageMetaRow } from '../interfaces'

/** Tranzakció-megszakítás eredménnyel (a rollback után ezt adjuk vissza). */
class ApplyAborted extends Error {
  constructor(readonly result: Exclude<WikiApplyChangeSetResult, { ok: true }>) {
    super('wiki_apply_aborted')
  }
}

/**
 * Áthelyezett (vagy törléskor átnevezett) oldal: a kategóriák kiemelt és kézi sorrendű
 * listájában is az új path álljon, ugyanabban a tranzakcióban.
 */
export async function replaceCategoryPagePath(tx: Prisma.TransactionClient, wikiId: string, from: string, to: string) {
  if (from === to) return
  await tx.$executeRaw`
    UPDATE wiki_categories
    SET pinned_pages = array_replace(pinned_pages, ${from}, ${to}),
        page_order = array_replace(page_order, ${from}, ${to}),
        updated_at = now()
    WHERE wiki_id = ${wikiId}::uuid
      AND (pinned_pages @> ARRAY[${from}]::text[] OR page_order @> ARRAY[${from}]::text[])`
}

/** A kategória-átrendezés közben eltűnt sor: az egész sorrend visszagörgetődik. */
class ReorderAborted extends Error {}

function pageData(page: WikiApplyPageOp['page']) {
  return {
    path: page.path,
    type: page.type,
    title: page.title,
    summary: page.summary,
    category: page.category ?? null,
    frontmatter: page.frontmatter ?? {},
    body: page.body,
    sourceRefs: page.sourceRefs ?? [],
    outLinks: page.outLinks ?? [],
    status: page.status ?? 'published',
    contentHash: page.contentHash,
    // #1061 F3: a beépített mezők csak akkor íródnak, ha a tervezés adta őket.
    ...(page.meta
      ? {
          docStatus: page.meta.docStatus,
          ownerUserId: page.meta.ownerUserId,
          ownerRole: page.meta.ownerRole,
          reviewedAt: page.meta.reviewedAt,
          reviewedByUserId: page.meta.reviewedByUserId,
          reviewCycleDays: page.meta.reviewCycleDays,
        }
      : {}),
  }
}

/** #978: a revízió a lap teljes állapotát őrzi (útvonal, állapot, források, szerző). */
export function revisionData(
  page: WikiPage,
  changeSetId: string | null,
  author: { actorAgentId?: string | null; actorUserId?: string | null },
): Prisma.WikiPageRevisionUncheckedCreateInput {
  return {
    pageId: page.id,
    changeSetId,
    version: page.version,
    title: page.title,
    summary: page.summary,
    body: page.body,
    frontmatter: page.frontmatter ?? {},
    contentHash: page.contentHash,
    path: page.path,
    status: page.status,
    type: page.type,
    category: page.category,
    sourceRefs: page.sourceRefs ?? [],
    // #1061 F3 NFR-4: a beépített mezők is a revízió részei (diff, visszaállítás, időutazás).
    meta: metaFromColumns(page) as unknown as Prisma.InputJsonValue,
    createdByAgentId: author.actorAgentId ?? null,
    createdByUserId: author.actorUserId ?? null,
  }
}

/**
 * #942: a lejárt foglalás olvasáskor `pending` (D6, háttérjob nélkül). A SQL-ág
 * ugyanazt számolja, mint a `wiki-access` `effectiveInboxStatus`.
 */
export function effectiveStatusSql(now: Date): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN d.wiki_status = 'pending'
      OR (d.wiki_status = 'in_progress' AND (d.wiki_claim_expires_at IS NULL OR d.wiki_claim_expires_at <= ${now}))
    THEN CASE WHEN d.wiki_reprocess IS NULL THEN 'pending' ELSE 'reprocess' END
    ELSE d.wiki_status::text
  END`
}

function emptyCounts(): WikiInboxCounts {
  return { pending: 0, reprocess: 0, inProgress: 0, processed: 0, skipped: 0 }
}

function addCount(counts: WikiInboxCounts, status: string, n: number) {
  if (status === 'pending') counts.pending += n
  else if (status === 'reprocess') counts.reprocess += n
  else if (status === 'in_progress') counts.inProgress += n
  else if (status === 'processed') counts.processed += n
  else if (status === 'skipped') counts.skipped += n
}

export class PostgresWikiRepository implements WikiRepository {
  findById(wikiId: string): Promise<AgentWiki | null> {
    return prisma.agentWiki.findUnique({ where: { id: wikiId } })
  }

  findByConnectorId(connectorId: string): Promise<AgentWiki | null> {
    return prisma.agentWiki.findUnique({ where: { connectorId } })
  }

  ensureForConnector(input: { connectorId: string; schemaMd: string }): Promise<AgentWiki> {
    return prisma.agentWiki.upsert({
      where: { connectorId: input.connectorId },
      create: { connectorId: input.connectorId, schemaMd: input.schemaMd },
      update: {},
    })
  }

  updateSchema(wikiId: string, schemaMd: string): Promise<AgentWiki> {
    return prisma.agentWiki.update({ where: { id: wikiId }, data: { schemaMd } })
  }

  async updateLastLint(wikiId: string, lastLint: Prisma.InputJsonValue): Promise<void> {
    await prisma.agentWiki.update({ where: { id: wikiId }, data: { lastLint } })
  }

  findPage(connectorId: string, path: string): Promise<WikiPage | null> {
    return prisma.wikiPage.findUnique({ where: { connectorId_path: { connectorId, path } } })
  }

  listPages(
    connectorId: string,
    filter: Parameters<WikiRepository['listPages']>[1] = {},
  ): Promise<WikiPage[]> {
    const status = filter.status
    return prisma.wikiPage.findMany({
      where: {
        connectorId,
        ...(status ? { status: Array.isArray(status) ? { in: status } : status } : {}),
        ...(filter.pathPrefix ? { path: { startsWith: filter.pathPrefix } } : {}),
        ...(filter.category ? { category: filter.category } : {}),
      },
      orderBy: [{ category: 'asc' }, { path: 'asc' }],
      ...(filter.limit ? { take: filter.limit } : {}),
    })
  }

  async searchPages(connectorId: string, query: { terms: string[]; language: string; limit: number }): Promise<WikiPageSearchResult> {
    if (query.terms.length === 0) return { terms: [], total: 0, hits: [] }
    const dictionary = Prisma.raw(`'${kbPgStemDict(query.language)}'::regdictionary`)
    const lexemes = await prisma.$queryRaw<Array<{ term: string; lexemes: string[] | null }>>`
      SELECT t.term, ts_lexize(${dictionary}, t.term) AS lexemes
      FROM unnest(${query.terms}::text[]) AS t(term)
    `
    const lexemeOf = new Map(lexemes.map((row) => [row.term, row.lexemes?.[0] ?? null]))
    const terms = query.terms.map((term) => kbTextTerm(term, lexemeOf.get(term)))
    const fold = (text: Prisma.Sql) => Prisma.sql`translate(lower(${text}), ${KB_FOLD_FROM}, ${KB_FOLD_TO})`
    const phrase = terms.map((term) => term.folded).join(' ')
    // ponytail: pásztázás index nélkül (#1136 D5); ha kinövi a keretet, pg_trgm GIN a hajtogatott kifejezésre.
    const rows = await prisma.$queryRaw<
      Array<{
        path: string
        title: string
        summary: string
        category: string | null
        body: string
        matched: bigint[]
        occurrences: bigint
        total: bigint
      }>
    >`
      SELECT p.path, p.title, p.summary, p.category, p.body, m.matched, m.occurrences,
             count(*) OVER () AS total
      FROM wiki_pages p
      -- OFFSET 0: e nélkül a tervező beinline-olja, és szavanként újra hajtogatná a szöveget.
      CROSS JOIN LATERAL (
        SELECT ${fold(Prisma.sql`p.title`)} AS title,
               ${fold(Prisma.sql`p.summary`)} AS summary,
               ${fold(Prisma.sql`p.title || E'\n' || p.summary || E'\n' || p.body`)} AS hay
        OFFSET 0
      ) f
      CROSS JOIN LATERAL (
        SELECT coalesce(array_agg(t.ord ORDER BY t.ord) FILTER (WHERE c.n > 0), '{}') AS matched,
               coalesce(sum(c.n), 0)::bigint AS occurrences,
               count(*) FILTER (WHERE c.n > 0 AND f.title ~ t.pattern) AS in_title,
               count(*) FILTER (WHERE c.n > 0 AND f.summary ~ t.pattern) AS in_summary,
               count(*) FILTER (WHERE c.n > 0 AND f.hay ~ t.literal) AS literal
        FROM unnest(${terms.map(kbTermPattern)}::text[], ${terms.map(kbLiteralPattern)}::text[], ${terms.map(kbTermNeedle)}::text[])
          WITH ORDINALITY AS t(pattern, literal, needle, ord)
        CROSS JOIN LATERAL (
          SELECT CASE WHEN position(t.needle IN f.hay) > 0 THEN regexp_count(f.hay, t.pattern) ELSE 0 END AS n
        ) c
      ) m
      WHERE p.connector_id = ${connectorId}::uuid
        AND p.status = CAST('published' AS "WikiPageStatus")
        AND cardinality(m.matched) > 0
      ORDER BY cardinality(m.matched) DESC,
               (position(${phrase} IN f.title) > 0) DESC,
               (m.in_title = ${terms.length}) DESC,
               m.in_title DESC,
               m.in_summary DESC,
               -- A szintetizált oldal előzze a forrás-kivonatot.
               (p.type <> CAST('source' AS "WikiPageType")) DESC,
               m.literal DESC,
               m.occurrences DESC,
               p.updated_at DESC,
               p.path ASC
      LIMIT ${query.limit}
    `
    return {
      terms,
      total: Number(rows[0]?.total ?? 0),
      hits: rows.map((row) => ({
        path: row.path,
        title: row.title,
        summary: row.summary,
        category: row.category,
        body: row.body,
        matchedTerms: row.matched.map((ord) => Number(ord) - 1),
        occurrences: Number(row.occurrences),
      })),
    }
  }

  async createPage(input: Parameters<WikiRepository['createPage']>[0]): Promise<WikiPage> {
    return prisma.$transaction(async (tx) => {
      const page = await tx.wikiPage.create({
        data: {
          wikiId: input.wikiId,
          connectorId: input.connectorId,
          path: input.path,
          type: input.type,
          title: input.title,
          summary: input.summary,
          category: input.category ?? null,
          frontmatter: input.frontmatter ?? {},
          body: input.body,
          sourceRefs: input.sourceRefs ?? [],
          outLinks: input.outLinks ?? [],
          status: input.status ?? 'published',
          contentHash: input.contentHash,
          createdByAgentId: input.createdByAgentId ?? null,
          createdByUserId: input.createdByUserId ?? null,
          updatedByAgentId: input.createdByAgentId ?? null,
        },
      })
      await tx.wikiPageRevision.create({
        data: revisionData(page, input.changeSetId ?? null, { actorAgentId: input.createdByAgentId, actorUserId: input.createdByUserId }),
      })
      return page
    })
  }

  async updatePage(
    pageId: string,
    expectedVersion: number,
    input: Parameters<WikiRepository['updatePage']>[2],
  ): Promise<WikiPage | null> {
    return prisma.$transaction(async (tx) => {
      const { changeSetId, updatedByAgentId, ...fields } = input
      const updated = await tx.wikiPage.updateMany({
        where: { id: pageId, version: expectedVersion },
        data: {
          ...(fields.path !== undefined ? { path: fields.path } : {}),
          ...(fields.type !== undefined ? { type: fields.type } : {}),
          ...(fields.title !== undefined ? { title: fields.title } : {}),
          ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
          ...(fields.category !== undefined ? { category: fields.category } : {}),
          ...(fields.frontmatter !== undefined ? { frontmatter: fields.frontmatter } : {}),
          ...(fields.body !== undefined ? { body: fields.body } : {}),
          ...(fields.sourceRefs !== undefined ? { sourceRefs: fields.sourceRefs } : {}),
          ...(fields.outLinks !== undefined ? { outLinks: fields.outLinks } : {}),
          ...(fields.status !== undefined ? { status: fields.status } : {}),
          contentHash: fields.contentHash,
          updatedByAgentId: updatedByAgentId ?? null,
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) return null
      const page = await tx.wikiPage.findUniqueOrThrow({ where: { id: pageId } })
      await tx.wikiPageRevision.create({
        data: revisionData(page, changeSetId ?? null, { actorAgentId: updatedByAgentId }),
      })
      return page
    })
  }

  listRevisions(pageId: string) {
    return prisma.wikiPageRevision.findMany({ where: { pageId }, orderBy: { version: 'desc' } })
  }

  createChangeSet(input: Parameters<WikiRepository['createChangeSet']>[0]): Promise<WikiChangeSet> {
    const data = {
      wikiId: input.wikiId,
      connectorId: input.connectorId,
      agentId: input.agentId ?? null,
      userId: input.userId ?? null,
      status: input.status ?? 'pending',
      pages: input.pages,
      validation: input.validation ?? Prisma.JsonNull,
      logEntry: input.logEntry ?? Prisma.JsonNull,
      sourceDocumentIds: input.sourceDocumentIds ?? [],
      inboxItemId: input.inboxItemId ?? null,
      approverScope: input.approverScope,
      revertsId: input.revertsId ?? null,
    } satisfies Prisma.WikiChangeSetUncheckedCreateInput
    const commentLinks = input.commentLinks
    if (!commentLinks?.links.length) return prisma.wikiChangeSet.create({ data })
    return prisma.$transaction(async (tx) => {
      const changeSet = await tx.wikiChangeSet.create({ data })
      await bindLinkedCommentsInTx(tx, {
        connectorId: input.connectorId,
        links: commentLinks.links,
        changeSetId: changeSet.id,
        actor: commentLinks.actor,
        partlyApplied: commentLinks.partlyApplied,
      })
      return changeSet
    })
  }

  findChangeSet(id: string): Promise<WikiChangeSet | null> {
    return prisma.wikiChangeSet.findUnique({ where: { id } })
  }

  async listPendingChangeSetIds(connectorId: string): Promise<string[]> {
    const rows = await prisma.wikiChangeSet.findMany({
      where: { connectorId, status: 'pending' },
      select: { id: true },
    })
    return rows.map((row) => row.id)
  }

  async transitionChangeSet(
    id: string,
    from: WikiChangeSet['status'],
    to: WikiChangeSet['status'],
    extra: {
      gatewayOperationId?: string | null
      appliedAt?: Date | null
      /** #1129: elutasításkor a kötött kommentek a change-settel együtt nyílnak vissza. */
      reopenComments?: { systemCode: string; body?: string | null; actor?: WikiCommentActor; now: Date }
    } = {},
  ): Promise<WikiChangeSet | null> {
    const data = {
      status: to,
      ...(extra.gatewayOperationId !== undefined ? { gatewayOperationId: extra.gatewayOperationId } : {}),
      ...(extra.appliedAt !== undefined ? { appliedAt: extra.appliedAt } : {}),
    }
    const reopen = extra.reopenComments
    if (reopen) {
      return prisma.$transaction(async (tx) => {
        const moved = await tx.wikiChangeSet.updateMany({ where: { id, status: from }, data })
        if (moved.count === 0) return null
        await reopenBoundCommentsInTx(tx, { changeSetId: id, from: 'pending_approval', ...reopen })
        return tx.wikiChangeSet.findUnique({ where: { id } })
      })
    }
    const result = await prisma.wikiChangeSet.updateMany({ where: { id, status: from }, data })
    if (result.count === 0) return null
    return prisma.wikiChangeSet.findUnique({ where: { id } })
  }

  appendLog(input: Parameters<WikiRepository['appendLog']>[0]) {
    return prisma.wikiLogEntry.create({
      data: {
        wikiId: input.wikiId,
        op: input.op,
        title: input.title,
        note: input.note ?? null,
        pagePaths: input.pagePaths ?? [],
        changeSetId: input.changeSetId ?? null,
        actorAgentId: input.actorAgentId ?? null,
        actorUserId: input.actorUserId ?? null,
      },
    })
  }

  async listLog(wikiId: string, limit = 200) {
    const take = Math.min(Math.max(limit, 1), 1000)
    const rows = await prisma.wikiLogEntry.findMany({
      where: { wikiId },
      orderBy: { createdAt: 'desc' },
      take,
    })
    return rows.reverse()
  }

  async listPagesCitingDocuments(connectorIds: string[], documentIds: string[]) {
    if (connectorIds.length === 0 || documentIds.length === 0) return []
    const rows = await prisma.$queryRaw<Array<{ document_id: string; path: string; title: string }>>(Prisma.sql`
      SELECT DISTINCT ref->>'documentId' AS document_id, p.path, p.title
      FROM wiki_pages p
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(p.source_refs) = 'array' THEN p.source_refs ELSE '[]'::jsonb END
      ) AS ref
      WHERE p.connector_id = ANY(${connectorIds}::uuid[])
        AND p.status = CAST('published' AS "WikiPageStatus")
        AND ref->>'documentId' = ANY(${documentIds}::text[])
        AND (ref->>'connectorId' IS NULL OR ref->>'connectorId' = p.connector_id::text)
      ORDER BY p.path
    `)
    return rows.map((row) => ({ documentId: row.document_id, path: row.path, title: row.title }))
  }

  async listInbox(
    connectorIds: string[],
    input: { now: Date; batchId?: string; limit?: number; includeDone?: boolean },
  ): Promise<WikiInboxItem[]> {
    if (connectorIds.length === 0) return []
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500)
    const status = effectiveStatusSql(input.now)
    const rows = await prisma.$queryRaw<
      Array<{
        id: string
        connector_id: string
        filename: string
        metadata: Prisma.JsonValue
        status: string
        uploaded_by: string
        wiki_submitted_by_agent_id: string | null
        wiki_claimed_by_agent_id: string | null
        wiki_claim_expires_at: Date | null
        wiki_batch_id: string | null
        wiki_batch_seq: number | null
        wiki_reprocess: Prisma.JsonValue
        created_at: Date
      }>
    >(Prisma.sql`
      SELECT d.id, d.connector_id, d.filename, d.metadata, ${status} AS status, d.uploaded_by,
             d.wiki_submitted_by_agent_id, d.wiki_claimed_by_agent_id, d.wiki_claim_expires_at,
             d.wiki_batch_id, d.wiki_batch_seq, d.wiki_reprocess, d.created_at
      FROM documents d
      WHERE d.connector_id = ANY(${connectorIds}::uuid[])
        AND ${input.includeDone ? Prisma.sql`d.wiki_status IS NOT NULL` : Prisma.sql`d.wiki_status IN ('pending', 'in_progress')`}
        ${input.batchId ? Prisma.sql`AND d.wiki_batch_id = ${input.batchId}::uuid` : Prisma.empty}
      ORDER BY CASE WHEN d.wiki_status IN ('pending', 'in_progress') THEN 0 ELSE 1 END,
               min(d.created_at) OVER (PARTITION BY COALESCE(d.wiki_batch_id, d.id)),
               COALESCE(d.wiki_batch_id, d.id),
               d.wiki_batch_seq NULLS LAST,
               d.created_at
      LIMIT ${limit}
    `)
    return rows.map((row) => {
      const active = row.status === 'in_progress'
      return {
        documentId: row.id,
        connectorId: row.connector_id,
        filename: row.filename,
        purpose: readKbPurpose(row.metadata),
        status: row.status as WikiInboxItem['status'],
        reprocess: parseWikiReprocess(row.wiki_reprocess),
        uploadedById: row.uploaded_by,
        submittedByAgentId: row.wiki_submitted_by_agent_id,
        claimedByAgentId: active ? row.wiki_claimed_by_agent_id : null,
        claimExpiresAt: active ? row.wiki_claim_expires_at : null,
        batchId: row.wiki_batch_id,
        batchSeq: row.wiki_batch_seq,
        createdAt: row.created_at,
      }
    })
  }

  async inboxSummary(
    connectorIds: string[],
    input: { now: Date; batchId?: string },
  ): Promise<WikiInboxSummary> {
    if (connectorIds.length === 0) return { wikis: [], batches: [] }
    const status = effectiveStatusSql(input.now)
    const rows = await prisma.$queryRaw<
      Array<{ connector_id: string; batch_id: string | null; status: string; n: bigint }>
    >(Prisma.sql`
      SELECT d.connector_id, d.wiki_batch_id AS batch_id, ${status} AS status, count(*) AS n
      FROM documents d
      WHERE d.connector_id = ANY(${connectorIds}::uuid[])
        AND d.wiki_status IS NOT NULL
        ${input.batchId ? Prisma.sql`AND d.wiki_batch_id = ${input.batchId}::uuid` : Prisma.empty}
      GROUP BY 1, 2, 3
    `)
    const wikis = new Map<string, { connectorId: string } & WikiInboxCounts>()
    const batches = new Map<string, { connectorId: string; batchId: string } & WikiInboxCounts>()
    for (const row of rows) {
      const n = Number(row.n)
      const wiki = wikis.get(row.connector_id) ?? { connectorId: row.connector_id, ...emptyCounts() }
      addCount(wiki, row.status, n)
      wikis.set(row.connector_id, wiki)
      if (row.batch_id) {
        const key = `${row.connector_id}:${row.batch_id}`
        const batch = batches.get(key) ?? {
          connectorId: row.connector_id,
          batchId: row.batch_id,
          ...emptyCounts(),
        }
        addCount(batch, row.status, n)
        batches.set(key, batch)
      }
    }
    return { wikis: [...wikis.values()], batches: [...batches.values()] }
  }

  async submitToInbox(input: Parameters<WikiRepository['submitToInbox']>[0]): Promise<void> {
    await prisma.document.update({
      where: { id: input.documentId },
      data: {
        wikiStatus: input.status,
        wikiSubmittedByAgentId: input.submittedByAgentId ?? null,
        wikiClaimedByAgentId: input.status === 'in_progress' ? (input.claimedByAgentId ?? null) : null,
        wikiClaimExpiresAt: input.status === 'in_progress' ? (input.claimExpiresAt ?? null) : null,
        wikiBatchId: input.batchId ?? null,
        wikiBatchSeq: input.batchSeq ?? null,
      },
    })
  }

  async claimInboxItem(input: {
    documentId: string
    connectorId: string
    agentId: string
    now: Date
    expiresAt: Date
  }): Promise<boolean> {
    const result = await prisma.document.updateMany({
      where: {
        id: input.documentId,
        connectorId: input.connectorId,
        OR: [
          { wikiStatus: 'pending' },
          { wikiStatus: 'in_progress', wikiClaimExpiresAt: null },
          { wikiStatus: 'in_progress', wikiClaimExpiresAt: { lte: input.now } },
          { wikiStatus: 'in_progress', wikiClaimedByAgentId: input.agentId },
        ],
      },
      data: {
        wikiStatus: 'in_progress',
        wikiClaimedByAgentId: input.agentId,
        wikiClaimExpiresAt: input.expiresAt,
      },
    })
    return result.count > 0
  }

  async releaseInboxItem(input: { documentId: string; agentId: string }): Promise<boolean> {
    const result = await prisma.document.updateMany({
      where: { id: input.documentId, wikiStatus: 'in_progress', wikiClaimedByAgentId: input.agentId },
      data: { wikiStatus: 'pending', wikiClaimedByAgentId: null, wikiClaimExpiresAt: null },
    })
    return result.count > 0
  }

  async releaseClaimsForAgent(input: { agentId: string; connectorIds?: string[] }): Promise<number> {
    const result = await prisma.document.updateMany({
      where: {
        wikiStatus: 'in_progress',
        wikiClaimedByAgentId: input.agentId,
        ...(input.connectorIds ? { connectorId: { in: input.connectorIds } } : {}),
      },
      data: { wikiStatus: 'pending', wikiClaimedByAgentId: null, wikiClaimExpiresAt: null },
    })
    return result.count
  }

  async markInboxProcessed(input: { documentId: string; changeSetId: string }): Promise<boolean> {
    const result = await prisma.document.updateMany({
      where: { id: input.documentId, wikiStatus: { in: ['pending', 'in_progress'] } },
      data: {
        wikiStatus: 'processed',
        wikiProcessedByChangeSetId: input.changeSetId,
        wikiClaimedByAgentId: null,
        wikiClaimExpiresAt: null,
      },
    })
    return result.count > 0
  }

  async skipInboxItem(input: { documentId: string; connectorId: string }): Promise<boolean> {
    const result = await prisma.document.updateMany({
      where: {
        id: input.documentId,
        connectorId: input.connectorId,
        wikiStatus: { in: ['pending', 'in_progress'] },
      },
      data: { wikiStatus: 'skipped', wikiClaimedByAgentId: null, wikiClaimExpiresAt: null },
    })
    return result.count > 0
  }

  async requestReprocess(input: Parameters<WikiRepository['requestReprocess']>[0]): Promise<WikiReprocessRequestResult> {
    const scope =
      'documentId' in input.target
        ? Prisma.sql`d.id = ${input.target.documentId}::uuid`
        : Prisma.sql`d.wiki_batch_id = ${input.target.batchId}::uuid`
    // A kérő `previousStatus`-a és a váró jóváhagyás ugyanebben az utasításban dől el.
    const hasPendingChange = Prisma.sql`EXISTS (
      SELECT 1 FROM wiki_change_sets c
      WHERE c.connector_id = d.connector_id
        AND c.status = CAST('pending' AS "WikiChangeSetStatus")
        AND (c.inbox_item_id = d.id OR d.id::text = ANY(c.source_document_ids)
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(c.pages) AS p
            LEFT JOIN wiki_pages wp ON wp.wiki_id = c.wiki_id AND wp.path = p->>'path'
            WHERE p->'frontmatter'->'sources' @> jsonb_build_array(jsonb_build_object('documentId', d.id::text))
              OR wp.source_refs @> jsonb_build_array(jsonb_build_object('documentId', d.id::text))
          ))
    )`
    const marked = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE documents d
      SET wiki_status = 'pending',
          wiki_processed_by_change_set_id = NULL,
          wiki_claimed_by_agent_id = NULL,
          wiki_claim_expires_at = NULL,
          wiki_reprocess = jsonb_build_object(
            'reason', ${input.reason}::text,
            'requestedAt', ${input.now.toISOString()}::text,
            'requestedBy', ${JSON.stringify(input.requestedBy)}::jsonb,
            'previousStatus', d.wiki_status::text,
            'previousChangeSetId', d.wiki_processed_by_change_set_id
          )
      WHERE d.connector_id = ${input.connectorId}::uuid
        AND ${scope}
        AND d.wiki_status IN ('processed', 'skipped')
        AND NOT ${hasPendingChange}
      RETURNING d.id
    `)
    const markedIds = marked.map((row) => row.id)
    const rest = await prisma.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
      SELECT d.id, d.wiki_status::text AS status
      FROM documents d
      WHERE d.connector_id = ${input.connectorId}::uuid
        AND ${scope}
        AND d.wiki_status IS NOT NULL
        AND NOT (d.id = ANY(${markedIds}::uuid[]))
    `)
    return {
      marked: markedIds,
      waitingForApproval: rest.filter((row) => row.status === 'processed' || row.status === 'skipped').map((row) => row.id),
      alreadyInInbox: rest.filter((row) => row.status === 'pending' || row.status === 'in_progress').map((row) => row.id),
    }
  }

  async cancelReprocess(input: { documentId: string; connectorId: string }): Promise<boolean> {
    const count = await prisma.$executeRaw(Prisma.sql`
      UPDATE documents d
      SET wiki_status = (d.wiki_reprocess->>'previousStatus')::"WikiInboxStatus",
          wiki_processed_by_change_set_id = (d.wiki_reprocess->>'previousChangeSetId')::uuid,
          wiki_claimed_by_agent_id = NULL,
          wiki_claim_expires_at = NULL,
          wiki_reprocess = NULL
      WHERE d.id = ${input.documentId}::uuid
        AND d.connector_id = ${input.connectorId}::uuid
        AND d.wiki_status IN ('pending', 'in_progress')
        AND d.wiki_reprocess IS NOT NULL
    `)
    return count > 0
  }

  async finishReprocessUnchanged(input: { documentId: string; connectorId: string; agentId: string; now: Date }): Promise<boolean> {
    const count = await prisma.$executeRaw(Prisma.sql`
      UPDATE documents d
      SET wiki_status = (d.wiki_reprocess->>'previousStatus')::"WikiInboxStatus",
          wiki_processed_by_change_set_id = (d.wiki_reprocess->>'previousChangeSetId')::uuid,
          wiki_claimed_by_agent_id = NULL,
          wiki_claim_expires_at = NULL,
          wiki_reprocess = d.wiki_reprocess || jsonb_build_object('outcome', 'unchanged', 'finishedAt', ${input.now.toISOString()}::text)
      WHERE d.id = ${input.documentId}::uuid
        AND d.connector_id = ${input.connectorId}::uuid
        AND d.wiki_status = 'in_progress'
        AND d.wiki_claimed_by_agent_id = ${input.agentId}::uuid
        AND d.wiki_claim_expires_at > ${input.now}
        AND d.wiki_reprocess IS NOT NULL
    `)
    return count > 0
  }

  async applyChangeSet(input: WikiApplyChangeSetInput): Promise<WikiApplyChangeSetResult> {
    try {
      return await prisma.$transaction(async (tx) => {
        // Egy wikin az írások sorban futnak: a konténer-artifact egyszer jön létre,
        // és két change-set chunk-cseréje nem keveredik.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.connectorId}))`
        if (input.configPlan) await applyConfigPlan(tx, input.wikiId, input.connectorId, input.configPlan)
        if (input.categoryUpdate) {
          const { id, expectedParentId, patch } = input.categoryUpdate
          const changed = await tx.wikiCategory.updateMany({ where: { id, wikiId: input.wikiId, parentId: expectedParentId }, data: patch })
          if (changed.count !== 1) throw new ApplyAborted({ ok: false, reason: 'conflict', path: null })
        }
        // #978 D6: a sorszám az alkalmazáskor születik; a sor-zár miatt két párhuzamos
        // alkalmazás nem kaphatja ugyanazt (a rollback a számot is visszaadja).
        const [allocated] = await tx.$queryRaw<Array<{ seq: number }>>`
          UPDATE agent_wikis SET next_seq = next_seq + 1
          WHERE id = ${input.wikiId}::uuid AND connector_id = ${input.connectorId}::uuid
          RETURNING next_seq - 1 AS seq
        `
        if (!allocated) throw new ApplyAborted({ ok: false, reason: 'changeset_not_pending' })
        const seq = Number(allocated.seq)
        let changeSetId: string
        let revertsId: string | null
        if ('id' in input.changeSet) {
          const moved = await tx.wikiChangeSet.updateMany({
            where: { id: input.changeSet.id, connectorId: input.connectorId, status: 'pending' },
            data: { status: 'applied', appliedAt: input.appliedAt, seq },
          })
          if (moved.count === 0) throw new ApplyAborted({ ok: false, reason: 'changeset_not_pending' })
          changeSetId = input.changeSet.id
          revertsId = (await tx.wikiChangeSet.findUnique({ where: { id: changeSetId }, select: { revertsId: true } }))?.revertsId ?? null
        } else {
          const created = input.changeSet.create
          const row = await tx.wikiChangeSet.create({
            data: {
              wikiId: created.wikiId,
              connectorId: created.connectorId,
              agentId: created.agentId ?? null,
              userId: created.userId ?? null,
              status: 'applied',
              appliedAt: input.appliedAt,
              pages: created.pages,
              validation: created.validation ?? Prisma.JsonNull,
              logEntry: created.logEntry ?? Prisma.JsonNull,
              sourceDocumentIds: created.sourceDocumentIds ?? [],
              inboxItemId: created.inboxItemId ?? null,
              approverScope: created.approverScope,
              revertsId: created.revertsId ?? null,
              seq,
            },
            select: { id: true },
          })
          changeSetId = row.id
          revertsId = created.revertsId ?? null
        }
        // #978 D5: a visszavont change-set `reverted`, és hivatkozik a visszaállítóra.
        let commentsReopened: string[] = []
        if (revertsId) {
          const marked = await tx.wikiChangeSet.updateMany({
            where: { id: revertsId, wikiId: input.wikiId, status: 'applied' },
            data: { status: 'reverted', revertedById: changeSetId },
          })
          if (marked.count === 0) throw new ApplyAborted({ ok: false, reason: 'changeset_not_revertible' })
          // #1129 AC8: ami a visszavont módosítással készült el, az újra nyitott.
          commentsReopened = await reopenBoundCommentsInTx(tx, {
            changeSetId: revertsId,
            from: 'resolved',
            systemCode: 'change_reverted',
            now: input.appliedAt,
          })
        }
        // #1129: közvetlen írásnál itt záródik a komment, jóváhagyásnál a hozzá kötöttek készülnek el.
        const commentsResolved =
          'id' in input.changeSet ? await resolveBoundCommentsInTx(tx, { changeSetId, now: input.appliedAt }) : []
        if (input.commentLinks?.links.length) {
          await closeLinkedCommentsInTx(tx, {
            connectorId: input.connectorId,
            links: input.commentLinks.links,
            changeSetId,
            actor: input.commentLinks.actor,
            now: input.appliedAt,
          })
          commentsResolved.push(...input.commentLinks.links.map((link) => link.commentId))
        }

        const container =
          (await tx.knowledgeArtifact.findFirst({
            where: { connectorId: input.connectorId, format: 'llm_wiki' },
            select: { id: true },
          })) ??
          (await tx.knowledgeArtifact.create({
            data: {
              connectorId: input.connectorId,
              format: 'llm_wiki',
              status: 'published',
              version: 1,
              contentHash: 'llm_wiki',
              bundle: {},
              publishedAt: input.appliedAt,
            },
            select: { id: true },
          }))

        const pages: WikiPage[] = []
        for (const op of input.ops) {
          let page
          if (op.kind === 'create') {
            page = await tx.wikiPage.create({
              data: {
                ...pageData(op.page),
                wikiId: input.wikiId,
                connectorId: input.connectorId,
                createdByAgentId: op.createdByAgentId ?? null,
                createdByUserId: op.createdByUserId ?? null,
                updatedByAgentId: op.createdByAgentId ?? null,
              },
            })
          } else {
            const updated = await tx.wikiPage.updateMany({
              where: { id: op.pageId, connectorId: input.connectorId, version: op.expectedVersion },
              data: {
                ...pageData(op.page),
                updatedByAgentId: op.updatedByAgentId ?? null,
                version: { increment: 1 },
              },
            })
            if (updated.count === 0) throw new ApplyAborted({ ok: false, reason: 'conflict', path: op.previousPath })
            page = await tx.wikiPage.findUniqueOrThrow({ where: { id: op.pageId } })
          }
          // Oldalanként csak az érintett chunkok cserélődnek (régi és új path).
          await tx.knowledgeChunk.deleteMany({
            where: {
              artifactId: container.id,
              path: { in: op.kind === 'update' ? [op.previousPath, page.path] : [page.path] },
            },
          })
          if (op.chunks.length > 0) {
            await tx.knowledgeChunk.createMany({
              data: op.chunks.map((chunk) => ({
                ...chunk,
                sourceRef: chunk.sourceRef ?? undefined,
                artifactId: container.id,
                connectorId: input.connectorId,
              })),
            })
          }
          if (op.kind === 'update') await replaceCategoryPagePath(tx, input.wikiId, op.previousPath, page.path)
          await tx.wikiPageRevision.create({ data: revisionData(page, changeSetId, input.log) })
          pages.push(page)
        }
        if (input.pageSummary) {
          const summary: WikiChangeSetPageSummary[] = input.pageSummary.map((row, i) => ({
            ...row,
            pageId: pages[i].id,
            version: pages[i].version,
          }))
          await tx.wikiChangeSet.update({
            where: { id: changeSetId },
            data: { pageSummary: summary as unknown as Prisma.InputJsonValue },
          })
        }

        if (input.configPlan) {
          await tx.wikiConfigProposal.update({ where: { id: input.configPlan.proposalId }, data: { changeSetId } })
        }

        await tx.wikiLogEntry.create({
          data: {
            wikiId: input.wikiId,
            op: input.log.op,
            title: input.log.title,
            note: input.log.note ?? null,
            pagePaths: input.log.pagePaths,
            changeSetId,
            actorAgentId: input.log.actorAgentId ?? null,
            actorUserId: input.log.actorUserId ?? null,
          },
        })

        if (input.inbox) {
          await tx.document.updateMany({
            where: {
              id: input.inbox.documentId,
              connectorId: input.connectorId,
              wikiStatus: { in: ['pending', 'in_progress'] },
            },
            data: input.inbox.final
              ? {
                  wikiStatus: 'processed',
                  wikiProcessedByChangeSetId: changeSetId,
                  wikiClaimedByAgentId: null,
                  wikiClaimExpiresAt: null,
                }
              : {
                  wikiStatus: 'in_progress',
                  wikiClaimedByAgentId: input.inbox.agentId,
                  wikiClaimExpiresAt: input.inbox.claimExpiresAt,
                },
          })
        }
        return { ok: true as const, changeSetId, seq, pages, commentsResolved, commentsReopened }
      })
    } catch (error) {
      if (error instanceof ApplyAborted) return error.result
      if (error instanceof WikiCommentNotOpenError) return { ok: false, reason: 'comment_not_open' }
      // Párhuzamos létrehozás ugyanarra a path-ra (unique connector+path).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { ok: false, reason: 'conflict', path: null }
      }
      throw error
    }
  }

  async reopenInboxItem(input: { documentId: string; changeSetId: string }): Promise<boolean> {
    const result = await prisma.document.updateMany({
      where: { id: input.documentId, wikiStatus: 'processed', wikiProcessedByChangeSetId: input.changeSetId },
      data: { wikiStatus: 'pending', wikiProcessedByChangeSetId: null, wikiClaimedByAgentId: null, wikiClaimExpiresAt: null },
    })
    return result.count > 0
  }

  async findContainerArtifactId(connectorId: string): Promise<string | null> {
    const row = await prisma.knowledgeArtifact.findFirst({
      where: { connectorId, format: 'llm_wiki' },
      select: { id: true },
    })
    return row?.id ?? null
  }

  findDocumentByContentHash(connectorId: string, contentHash: string) {
    return prisma.document.findFirst({
      where: { connectorId, contentHash },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
  }
}

const categorySelect = {
  id: true,
  key: true,
  parentId: true,
  name: true,
  description: true,
  sortOrder: true,
  approval: true,
  linkedConnectorId: true,
  reviewCycleDays: true,
  requiredFields: true,
  requiredSections: true,
  sectionRule: true,
  templateMd: true,
  pageSort: true,
  pinnedPages: true,
  pageOrder: true,
  collapsed: true,
  templateKey: true,
} as const

const fieldSelect = { id: true, key: true, name: true, type: true, options: true, help: true, sortOrder: true } as const

async function loadConfigState(client: Prisma.TransactionClient, wikiId: string): Promise<WikiConfigState | null> {
  const wiki = await client.agentWiki.findUnique({
    where: { id: wikiId },
    select: {
      schemaMd: true,
      collectFocus: true,
      managedCategories: true,
      managedFields: true,
      connector: { select: { config: true } },
      categories: { select: { ...categorySelect, parent: { select: { key: true } } } },
      fields: { select: fieldSelect },
    },
  })
  if (!wiki) return null
  const config = wiki.connector.config && typeof wiki.connector.config === 'object' && !Array.isArray(wiki.connector.config)
    ? (wiki.connector.config as Record<string, unknown>)
    : {}
  return {
    name: typeof config.displayName === 'string' && config.displayName.trim() ? config.displayName.trim() : null,
    collect: wiki.collectFocus,
    wikiMd: wiki.schemaMd,
    managedCategories: wiki.managedCategories,
    managedFields: wiki.managedFields,
    categories: wiki.categories.map((row) => ({
      key: row.key,
      parentKey: row.parent?.key ?? null,
      name: row.name,
      description: row.description,
      sortOrder: row.sortOrder,
      approval: row.approval,
      pageSort: row.pageSort,
      pinnedPages: row.pinnedPages,
      pageOrder: row.pageOrder,
      collapsed: row.collapsed,
      reviewCycleDays: row.reviewCycleDays,
      requiredFields: row.requiredFields,
      requiredSections: row.requiredSections,
      sectionRule: row.sectionRule,
      templateMd: row.templateMd,
      templateKey: row.templateKey,
      linkedConnectorId: row.linkedConnectorId,
    })),
    fields: wiki.fields.map((row) => ({
      key: row.key,
      name: row.name,
      type: row.type,
      options: row.options,
      help: row.help,
      sortOrder: row.sortOrder,
    })),
  }
}

/**
 * #1075: a jóváhagyott állapot kiírása a change-set tranzakciójában. Itt, a zár alatt
 * dől el véglegesen, hogy a beállítás azóta nem változott, és a javaslat még függőben van.
 */
async function applyConfigPlan(tx: Prisma.TransactionClient, wikiId: string, connectorId: string, plan: WikiConfigApplyPlan) {
  const claimed = await tx.wikiConfigProposal.updateMany({
    where: { id: plan.proposalId, wikiId, connectorId, status: 'pending' },
    data: { status: 'applied', decidedByUserId: plan.decidedByUserId, decidedAt: new Date() },
  })
  if (claimed.count !== 1) throw new ApplyAborted({ ok: false, reason: 'proposal_not_pending' })
  // A felületi írások nem veszik fel a change-set zárát: a sor-zárak miatt a lenyomat után már nem
  // csúszhat be mentés, amit a kiírás felülírna. A wiki-sor FOR UPDATE-je az új kategória / mező
  // beszúrását is megvárja (idegen kulcs); a connectornál elég a gyengébb, más táblákat nem fogó zár.
  await tx.$queryRaw`SELECT id FROM connectors WHERE id = ${connectorId}::uuid FOR NO KEY UPDATE`
  await tx.$queryRaw`SELECT id FROM agent_wikis WHERE id = ${wikiId}::uuid FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM wiki_categories WHERE wiki_id = ${wikiId}::uuid ORDER BY id FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM wiki_fields WHERE wiki_id = ${wikiId}::uuid ORDER BY id FOR UPDATE`
  const current = await loadConfigState(tx, wikiId)
  if (!current || configVersionOf(current) !== plan.expectedVersion) throw new ApplyAborted({ ok: false, reason: 'config_conflict' })
  const pages = await tx.wikiPage.findMany({ where: { wikiId, connectorId }, select: { id: true, version: true } })
  if (configPagesVersionOf(pages) !== plan.expectedPagesVersion) throw new ApplyAborted({ ok: false, reason: 'conflict', path: null })
  const { next } = plan

  // A fa kulcsokkal jön; előbb a felső szint, hogy a gyerek megtalálja a szülőjét.
  const wanted = new Set(next.categories.map((row) => row.key))
  const removed = current.categories.filter((row) => !wanted.has(row.key))
  const before = new Map(current.categories.map((row) => [row.key, JSON.stringify(row)]))
  for (const row of [...next.categories].sort((a, b) => Number(!!a.parentKey) - Number(!!b.parentKey))) {
    if (before.get(row.key) === JSON.stringify(row)) continue
    const parentId = row.parentKey
      ? (await tx.wikiCategory.findUniqueOrThrow({ where: { wikiId_key: { wikiId, key: row.parentKey } }, select: { id: true } })).id
      : null
    const data = {
      name: row.name,
      description: row.description,
      sortOrder: row.sortOrder,
      approval: row.approval,
      pageSort: row.pageSort,
      pinnedPages: row.pinnedPages,
      pageOrder: row.pageOrder,
      collapsed: row.collapsed,
      reviewCycleDays: row.reviewCycleDays,
      requiredFields: row.requiredFields,
      requiredSections: row.requiredSections,
      sectionRule: row.sectionRule,
      templateMd: row.templateMd,
      templateKey: row.templateKey,
      parentId,
    }
    await tx.wikiCategory.upsert({
      where: { wikiId_key: { wikiId, key: row.key } },
      create: { ...data, key: row.key, wikiId },
      update: data,
    })
  }
  // Előbb a megmaradó gyerekek kapják meg az új szülőt, csak utána törölhető a régi.
  for (const row of [...removed].sort((a, b) => Number(!!b.parentKey) - Number(!!a.parentKey))) {
    await tx.wikiCategory.deleteMany({ where: { wikiId, key: row.key } })
  }
  for (const row of next.fields) {
    const { key, ...data } = row
    await tx.wikiField.upsert({ where: { wikiId_key: { wikiId, key } }, create: { ...row, wikiId }, update: data })
  }
  await tx.agentWiki.update({ where: { id: wikiId }, data: { schemaMd: next.wikiMd, collectFocus: next.collect } })
  if (next.name !== current.name && next.name) {
    const connector = await tx.connector.findUniqueOrThrow({ where: { id: connectorId }, select: { config: true } })
    const config = connector.config && typeof connector.config === 'object' && !Array.isArray(connector.config) ? connector.config : {}
    await tx.connector.update({ where: { id: connectorId }, data: { config: { ...config, displayName: next.name } } })
  }
}

/** #1075: agent-javaslatok és a javasolható beállítások élő állapota. */
export class PostgresWikiConfigRepository implements WikiConfigRepository {
  readState(wikiId: string) {
    return loadConfigState(prisma, wikiId)
  }

  async createProposal(input: Parameters<WikiConfigRepository['createProposal']>[0]) {
    try {
      return await prisma.wikiConfigProposal.create({ data: input })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null
      throw error
    }
  }

  findProposal(id: string) {
    return prisma.wikiConfigProposal.findUnique({ where: { id } })
  }

  findPendingForAgent(wikiId: string, agentId: string) {
    return prisma.wikiConfigProposal.findFirst({ where: { wikiId, agentId, status: 'pending' } })
  }

  listProposals(wikiId: string, filter: { pending: boolean; agentId?: string; limit: number }) {
    return prisma.wikiConfigProposal.findMany({
      where: {
        wikiId,
        ...(filter.agentId ? { agentId: filter.agentId } : {}),
        status: filter.pending ? 'pending' : { not: 'pending' },
      },
      orderBy: { createdAt: 'desc' },
      take: filter.limit,
    })
  }

  async closeProposal(id: string, to: 'rejected' | 'withdrawn', extra: Parameters<WikiConfigRepository['closeProposal']>[2]) {
    const closed = await prisma.wikiConfigProposal.updateMany({ where: { id, status: 'pending' }, data: { status: to, ...extra } })
    return closed.count === 1 ? prisma.wikiConfigProposal.findUnique({ where: { id } }) : null
  }

  async agentConfigChanges(wikiId: string) {
    const row = await prisma.agentWiki.findUnique({ where: { id: wikiId }, select: { agentConfigChanges: true } })
    return row?.agentConfigChanges ?? false
  }

  async setAgentConfigChanges(wikiId: string, on: boolean) {
    await prisma.agentWiki.update({ where: { id: wikiId }, data: { agentConfigChanges: on } })
  }

  async setCollectFocus(wikiId: string, collect: string | null) {
    await prisma.agentWiki.update({ where: { id: wikiId }, data: { collectFocus: collect } })
  }
}

/** #1061 F1: kezelt kategória-fa és visszahivatkozások. */
export class PostgresWikiStructureRepository implements WikiStructureRepository {
  async isManaged(wikiId: string): Promise<boolean> {
    const row = await prisma.agentWiki.findUnique({ where: { id: wikiId }, select: { managedCategories: true } })
    return row?.managedCategories ?? false
  }

  async setManaged(wikiId: string, managed: boolean): Promise<void> {
    await prisma.agentWiki.update({ where: { id: wikiId }, data: { managedCategories: managed } })
  }

  listCategories(wikiId: string): Promise<WikiCategoryRow[]> {
    return prisma.wikiCategory.findMany({
      where: { wikiId },
      select: categorySelect,
      orderBy: [{ sortOrder: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
    })
  }

  createCategory(input: Omit<WikiCategoryRow, 'id'> & { wikiId: string }): Promise<WikiCategoryRow> {
    return prisma.wikiCategory.create({ data: input, select: categorySelect })
  }

  async updateCategory(
    wikiId: string,
    id: string,
    patch: Parameters<WikiStructureRepository['updateCategory']>[2],
  ): Promise<WikiCategoryRow | null> {
    const result = await prisma.wikiCategory.updateMany({ where: { id, wikiId }, data: patch })
    if (result.count === 0) return null
    return prisma.wikiCategory.findUnique({ where: { id }, select: categorySelect })
  }

  async reorderCategories(wikiId: string, parentId: string | null, orders: Array<{ id: string; sortOrder: number }>): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const siblings = await tx.wikiCategory.findMany({
        where: { wikiId, parentId, linkedConnectorId: null },
        select: { id: true, sortOrder: true },
      })
      const ids = new Set(orders.map((row) => row.id))
      if (ids.size !== orders.length || siblings.length !== ids.size || siblings.some((row) => !ids.has(row.id))) {
        throw new ReorderAborted()
      }
      for (const row of orders) {
        if (siblings.find((sibling) => sibling.id === row.id)!.sortOrder === row.sortOrder) continue
        const result = await tx.wikiCategory.updateMany({ where: { id: row.id, wikiId }, data: { sortOrder: row.sortOrder } })
        if (result.count === 0) throw new ReorderAborted()
      }
      return true
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((error) => {
      if (error instanceof ReorderAborted || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034')) return false
      throw error
    })
  }

  async deleteCategory(wikiId: string, id: string): Promise<boolean> {
    const result = await prisma.wikiCategory.deleteMany({ where: { id, wikiId, children: { none: {} } } })
    return result.count > 0
  }

  async listBacklinks(connectorId: string, path: string, limit: number) {
    const rows = await prisma.$queryRaw<Array<{ path: string; title: string; category: string | null; total: bigint }>>`
      SELECT path, title, category, count(*) OVER () AS total
      FROM wiki_pages
      WHERE connector_id = ${connectorId}::uuid
        AND status = 'published'
        AND out_links @> ARRAY[${path}]::text[]
        AND path <> ${path}
      ORDER BY category NULLS LAST, path
      LIMIT ${limit}`
    return {
      count: rows.length ? Number(rows[0].total) : 0,
      pages: rows.map(({ path: pagePath, title, category }) => ({ path: pagePath, title, category })),
    }
  }

  async listCrossBacklinks(tenantId: string, outLink: string, limit: number) {
    const rows = await prisma.$queryRaw<
      Array<{ wiki_id: string; connector_id: string; path: string; title: string; category: string | null }>
    >`
      SELECT p.wiki_id, p.connector_id, p.path, p.title, p.category
      FROM wiki_pages p
      JOIN connectors c ON c.id = p.connector_id
      WHERE c.tenant_id = ${tenantId}::uuid
        AND p.status = 'published'
        AND p.out_links @> ARRAY[${outLink}]::text[]
      ORDER BY p.connector_id, p.category NULLS LAST, p.path
      LIMIT ${limit}`
    return rows.map((row) => ({
      wikiId: row.wiki_id,
      connectorId: row.connector_id,
      path: row.path,
      title: row.title,
      category: row.category,
    }))
  }

  // #1061 F3: metaadat-mezők és nézetek ------------------------------------

  async fieldSettings(wikiId: string): Promise<{ managed: boolean; fields: WikiFieldDef[] }> {
    const [wiki, fields] = await Promise.all([
      prisma.agentWiki.findUnique({ where: { id: wikiId }, select: { managedFields: true } }),
      prisma.wikiField.findMany({ where: { wikiId }, select: fieldSelect, orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] }),
    ])
    return { managed: wiki?.managedFields ?? false, fields }
  }

  async setFieldsManaged(wikiId: string, managed: boolean): Promise<void> {
    await prisma.agentWiki.update({ where: { id: wikiId }, data: { managedFields: managed } })
  }

  createField(input: Omit<WikiFieldDef, 'id'> & { wikiId: string }): Promise<WikiFieldDef> {
    return prisma.wikiField.create({ data: input, select: fieldSelect })
  }

  async updateField(
    wikiId: string,
    id: string,
    patch: Partial<Pick<WikiFieldDef, 'name' | 'options' | 'help' | 'sortOrder'>>,
  ): Promise<WikiFieldDef | null> {
    const result = await prisma.wikiField.updateMany({ where: { id, wikiId }, data: patch })
    if (result.count === 0) return null
    return prisma.wikiField.findUnique({ where: { id }, select: fieldSelect })
  }

  async deleteField(wikiId: string, id: string): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const field = await tx.wikiField.findFirst({ where: { id, wikiId }, select: { key: true } })
      if (!field) return false
      await tx.wikiField.delete({ where: { id } })
      // A törölt mező kötelezősége se maradjon a kategóriákon (az értékek szabad kulcsként maradnak).
      await tx.$executeRaw`
        UPDATE wiki_categories SET required_fields = array_remove(required_fields, ${field.key}), updated_at = now()
        WHERE wiki_id = ${wikiId}::uuid AND ${field.key} = ANY(required_fields)`
      return true
    })
  }

  async listPageMeta(connectorId: string, filter: WikiPageMetaQuery): Promise<WikiPageMetaRow[]> {
    const conditions: Prisma.Sql[] = [Prisma.sql`p.connector_id = ${connectorId}::uuid`, Prisma.sql`p.status = 'published'`]
    if (filter.docStatus?.length) {
      const values = filter.docStatus.filter((value) => value !== 'none')
      const none = filter.docStatus.includes('none')
      const parts = [
        ...(values.length ? [Prisma.sql`p.doc_status::text = ANY(${values}::text[])`] : []),
        ...(none ? [Prisma.sql`p.doc_status IS NULL`] : []),
      ]
      conditions.push(Prisma.sql`(${Prisma.join(parts, ' OR ')})`)
    }
    if (filter.ownerUserIds) {
      conditions.push(
        filter.ownerUserIds.length ? Prisma.sql`p.owner_user_id = ANY(${filter.ownerUserIds}::uuid[])` : Prisma.sql`false`,
      )
    }
    if (filter.categories?.length) {
      const parts = filter.categories.map(
        (path) => Prisma.sql`(lower(p.category) = ${path} OR lower(p.category) LIKE ${`${path.replace(/[\\%_]/g, '\\$&')}/%`})`,
      )
      conditions.push(Prisma.sql`(${Prisma.join(parts, ' OR ')})`)
    }
    for (const field of filter.fields ?? []) {
      // `@>` a GIN (jsonb_path_ops) indexen: egyértékű és több-választós (tömb) mezőre is.
      const parts = field.values.flatMap((value) => [
        Prisma.sql`p.frontmatter @> ${JSON.stringify({ [field.key]: value })}::jsonb`,
        Prisma.sql`p.frontmatter @> ${JSON.stringify({ [field.key]: [value] })}::jsonb`,
      ])
      conditions.push(Prisma.sql`(${Prisma.join(parts, ' OR ')})`)
    }
    if (filter.orphansOnly) {
      conditions.push(Prisma.sql`p.type <> 'overview'`)
      conditions.push(Prisma.sql`NOT EXISTS (
        SELECT 1 FROM wiki_pages q
        WHERE q.connector_id = p.connector_id AND q.status = 'published'
          AND q.out_links @> ARRAY[p.path]::text[] AND q.path <> p.path)`)
    }
    const rows = await prisma.$queryRaw<
      Array<{
        path: string
        title: string
        summary: string
        type: string
        category: string | null
        frontmatter: unknown
        doc_status: 'draft' | 'approved' | null
        owner_user_id: string | null
        owner_role: string | null
        reviewed_at: Date | null
        reviewed_by_user_id: string | null
        review_cycle_days: number | null
        created_at: Date
        updated_at: Date
      }>
    >(Prisma.sql`
      SELECT p.path, p.title, p.summary, p.type::text AS type, p.category, p.frontmatter, p.doc_status::text AS doc_status,
             p.owner_user_id, p.owner_role, p.reviewed_at, p.reviewed_by_user_id, p.review_cycle_days,
             p.created_at, p.updated_at
      FROM wiki_pages p
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY p.category NULLS LAST, p.path`)
    return rows.map((row) => ({
      path: row.path,
      title: row.title,
      summary: row.summary,
      type: row.type,
      category: row.category,
      frontmatter: row.frontmatter,
      docStatus: row.doc_status,
      ownerUserId: row.owner_user_id,
      ownerRole: row.owner_role,
      reviewedAt: row.reviewed_at,
      reviewedByUserId: row.reviewed_by_user_id,
      reviewCycleDays: row.review_cycle_days,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }
}

export class PostgresPrivateKnowledgeBaseStore implements PrivateKnowledgeBaseStore {
  async findPrivate(connectorId: string): Promise<PrivateKnowledgeBaseRow | null> {
    const row = await prisma.connector.findFirst({
      where: { id: connectorId, type: 'knowledge_base', visibility: 'private_to_user' },
      select: { id: true, tenantId: true, ownerUserId: true },
    })
    if (!row?.ownerUserId) return null
    return { connectorId: row.id, tenantId: row.tenantId, ownerUserId: row.ownerUserId }
  }

  async listPrivateForOwner(tenantId: string, ownerUserId: string): Promise<PrivateKnowledgeBaseRow[]> {
    const rows = await prisma.connector.findMany({
      where: { tenantId, type: 'knowledge_base', visibility: 'private_to_user', ownerUserId },
      select: { id: true, tenantId: true, ownerUserId: true },
      orderBy: { createdAt: 'asc' },
    })
    return rows.map((row) => ({ connectorId: row.id, tenantId: row.tenantId, ownerUserId: row.ownerUserId! }))
  }

  async listOrphaned(input: { olderThan: Date; now: Date }): Promise<PrivateKnowledgeBaseRow[]> {
    // Hiányzó tagságnál nincs eltávolítási dátum: az első észleléstől indul
    // a 30 nap, nem a KB létrehozásától. Visszaállításkor az óra nullázódik.
    await prisma.$executeRaw`
      UPDATE connectors c SET owner_missing_since = CASE
        WHEN EXISTS (SELECT 1 FROM tenant_memberships m
          WHERE m.tenant_id = c.tenant_id AND m.user_id = c.owner_user_id)
        THEN NULL ELSE COALESCE(c.owner_missing_since, ${input.now}) END
      WHERE c.type = 'knowledge_base' AND c.visibility = 'private_to_user'
    `
    const rows = await prisma.$queryRaw<Array<{ id: string; tenant_id: string; owner_user_id: string }>>`
      SELECT c.id, c.tenant_id, c.owner_user_id
      FROM connectors c
      LEFT JOIN tenant_memberships m ON m.tenant_id = c.tenant_id AND m.user_id = c.owner_user_id
      WHERE c.type = 'knowledge_base'
        AND c.visibility = 'private_to_user'
        AND c.owner_user_id IS NOT NULL
        AND ((m.id IS NULL AND c.owner_missing_since <= ${input.olderThan})
          OR (m.status <> 'active' AND m.updated_at <= ${input.olderThan}))
      ORDER BY c.created_at
    `
    return rows.map((row) => ({ connectorId: row.id, tenantId: row.tenant_id, ownerUserId: row.owner_user_id }))
  }

  purge(connectorId: string): Promise<PrivateKnowledgeBasePurgeCounts>
  purge(connectorId: string, input: { olderThan: Date }): Promise<PrivateKnowledgeBasePurgeCounts | null>
  async purge(connectorId: string, input?: { olderThan: Date }): Promise<PrivateKnowledgeBasePurgeCounts | null> {
    return prisma.$transaction(async (tx) => {
      const connector = await tx.connector.findFirst({
        where: { id: connectorId, type: 'knowledge_base', visibility: 'private_to_user' },
        select: { id: true, tenantId: true, ownerUserId: true, ownerMissingSince: true },
      })
      if (!connector) {
        if (input) return null
        throw new Error('private_kb_not_found')
      }
      // A tagság a listázás és a törlés között visszaállhatott. Serializable
      // tranzakció: párhuzamos visszaállításkor a törlés inkább megszakad.
      if (input) {
        const membership = await tx.tenantMembership.findUnique({
          where: { tenantId_userId: { tenantId: connector.tenantId, userId: connector.ownerUserId! } },
        })
        if (membership
          ? membership.status === 'active' || membership.updatedAt > input.olderThan
          : !connector.ownerMissingSince || connector.ownerMissingSince > input.olderThan) return null
      }
      const pageIds = (await tx.wikiPage.findMany({ where: { connectorId }, select: { id: true } })).map(
        (row) => row.id,
      )
      // A kommentek az oldallal törlődnek (Cascade), ezért előtte számolunk.
      const comments = await tx.wikiComment.count({ where: { connectorId } })
      const counts: PrivateKnowledgeBasePurgeCounts = {
        comments,
        revisions: pageIds.length
          ? (await tx.wikiPageRevision.deleteMany({ where: { pageId: { in: pageIds } } })).count
          : 0,
        pages: (await tx.wikiPage.deleteMany({ where: { connectorId } })).count,
        changeSets: (await tx.wikiChangeSet.deleteMany({ where: { connectorId } })).count,
        logEntries: (await tx.wikiLogEntry.deleteMany({ where: { wiki: { connectorId } } })).count,
        chunks: (await tx.knowledgeChunk.deleteMany({ where: { connectorId } })).count,
        artifacts: (await tx.knowledgeArtifact.deleteMany({ where: { connectorId } })).count,
        // A dokumentum FK-ja SetNull — kifejezetten törölni kell, különben árva nyers forrás marad.
        documents: (await tx.document.deleteMany({ where: { connectorId } })).count,
        // A jóváhagyásra váró wiki-írás argumentuma tartalmat hordoz; a jóváhagyás cascade-del megy.
        gatewayOperations: (await tx.gatewayOperation.deleteMany({ where: { connectorId } })).count,
        agentLinks: (await tx.agentConnector.deleteMany({ where: { connectorId } })).count,
      }
      await tx.agentWiki.deleteMany({ where: { connectorId } })
      await tx.connector.delete({ where: { id: connectorId } })
      return counts
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }
}

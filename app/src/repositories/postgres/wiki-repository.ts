import { Prisma, type AgentWiki, type WikiChangeSet, type WikiPage } from '@prisma/client'
import { prisma } from '@/lib/db'
import { readKbPurpose } from '@/lib/kb-retrieval'
import type {
  PrivateKnowledgeBasePurgeCounts,
  PrivateKnowledgeBaseRow,
  PrivateKnowledgeBaseStore,
  WikiInboxCounts,
  WikiInboxItem,
  WikiApplyChangeSetInput,
  WikiApplyChangeSetResult,
  WikiApplyPageOp,
  WikiChangeSetPageSummary,
  WikiInboxSummary,
  WikiRepository,
} from '../interfaces'

/** Tranzakció-megszakítás eredménnyel (a rollback után ezt adjuk vissza). */
class ApplyAborted extends Error {
  constructor(readonly result: Exclude<WikiApplyChangeSetResult, { ok: true }>) {
    super('wiki_apply_aborted')
  }
}

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
  }
}

/** #978: a revízió a lap teljes állapotát őrzi (útvonal, állapot, források, szerző). */
function revisionData(
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
    createdByAgentId: author.actorAgentId ?? null,
    createdByUserId: author.actorUserId ?? null,
  }
}

/**
 * #942: a lejárt foglalás olvasáskor `pending` (D6, háttérjob nélkül). A SQL-ág
 * ugyanazt számolja, mint a `wiki-access` `effectiveInboxStatus`.
 */
function effectiveStatusSql(now: Date): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN d.wiki_status = 'in_progress'
      AND (d.wiki_claim_expires_at IS NULL OR d.wiki_claim_expires_at <= ${now})
    THEN 'pending'
    ELSE d.wiki_status::text
  END`
}

function emptyCounts(): WikiInboxCounts {
  return { pending: 0, inProgress: 0, processed: 0, skipped: 0 }
}

function addCount(counts: WikiInboxCounts, status: string, n: number) {
  if (status === 'pending') counts.pending += n
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
    return prisma.wikiChangeSet.create({
      data: {
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
      },
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
    extra: { gatewayOperationId?: string | null; appliedAt?: Date | null } = {},
  ): Promise<WikiChangeSet | null> {
    const result = await prisma.wikiChangeSet.updateMany({
      where: { id, status: from },
      data: {
        status: to,
        ...(extra.gatewayOperationId !== undefined ? { gatewayOperationId: extra.gatewayOperationId } : {}),
        ...(extra.appliedAt !== undefined ? { appliedAt: extra.appliedAt } : {}),
      },
    })
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

  async listInbox(
    connectorIds: string[],
    input: { now: Date; batchId?: string; limit?: number },
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
        created_at: Date
      }>
    >(Prisma.sql`
      SELECT d.id, d.connector_id, d.filename, d.metadata, ${status} AS status, d.uploaded_by,
             d.wiki_submitted_by_agent_id, d.wiki_claimed_by_agent_id, d.wiki_claim_expires_at,
             d.wiki_batch_id, d.wiki_batch_seq, d.created_at
      FROM documents d
      WHERE d.connector_id = ANY(${connectorIds}::uuid[])
        AND d.wiki_status IN ('pending', 'in_progress')
        ${input.batchId ? Prisma.sql`AND d.wiki_batch_id = ${input.batchId}::uuid` : Prisma.empty}
      ORDER BY min(d.created_at) OVER (PARTITION BY COALESCE(d.wiki_batch_id, d.id)),
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
        status: active ? 'in_progress' : 'pending',
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

  async applyChangeSet(input: WikiApplyChangeSetInput): Promise<WikiApplyChangeSetResult> {
    try {
      return await prisma.$transaction(async (tx) => {
        // Egy wikin az írások sorban futnak: a konténer-artifact egyszer jön létre,
        // és két change-set chunk-cseréje nem keveredik.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.connectorId}))`
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
        if (revertsId) {
          const marked = await tx.wikiChangeSet.updateMany({
            where: { id: revertsId, wikiId: input.wikiId, status: 'applied' },
            data: { status: 'reverted', revertedById: changeSetId },
          })
          if (marked.count === 0) throw new ApplyAborted({ ok: false, reason: 'changeset_not_revertible' })
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
        return { ok: true as const, changeSetId, seq, pages }
      })
    } catch (error) {
      if (error instanceof ApplyAborted) return error.result
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
      const counts: PrivateKnowledgeBasePurgeCounts = {
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

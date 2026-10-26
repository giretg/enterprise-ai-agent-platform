import { Prisma, type AgentWiki, type WikiChangeSet, type WikiPage, type WikiPageRevision, type WikiTag } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  WikiChangeSetPageSummary,
  WikiErasureWrite,
  WikiHistoryRepository,
  WikiRetentionCounts,
  WikiStateRow,
} from '../interfaces'
import { revisionData } from './wiki-repository'

/** A wiki-írást lezáró gateway-sorok, amelyek még döntésre / futásra várnak. */
const OPEN_GATEWAY_STATUSES = ['requested', 'awaiting_approval', 'approved', 'executing'] as const

class ErasureAborted extends Error {
  constructor() {
    super('wiki_erasure_conflict')
  }
}

/**
 * #978 Wiki-előzmények (Postgres). A wiki-írás (`applyChangeSet`) a
 * `PostgresWikiRepository`-ban marad; itt az olvasó, megőrző és törlő utak élnek.
 */
export class PostgresWikiHistoryRepository implements WikiHistoryRepository {
  listChangeSets(wikiId: string, filter: Parameters<WikiHistoryRepository['listChangeSets']>[1]): Promise<WikiChangeSet[]> {
    return prisma.wikiChangeSet.findMany({
      where: {
        wikiId,
        seq: {
          not: null,
          ...(filter.afterSeq !== undefined ? { gt: filter.afterSeq } : {}),
          ...(filter.beforeSeq !== undefined ? { lt: filter.beforeSeq } : {}),
        },
        ...(filter.agentId ? { agentId: filter.agentId } : {}),
        ...(filter.userId ? { userId: filter.userId, agentId: null } : {}),
        ...(filter.from || filter.to
          ? { appliedAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
      },
      orderBy: { seq: filter.order },
      take: Math.min(Math.max(filter.limit, 1), 500),
    })
  }

  findChangeSetBySeq(wikiId: string, seq: number): Promise<WikiChangeSet | null> {
    return prisma.wikiChangeSet.findUnique({ where: { wikiId_seq: { wikiId, seq } } })
  }

  findChangeSetInWiki(wikiId: string, changeSetId: string): Promise<WikiChangeSet | null> {
    return prisma.wikiChangeSet.findFirst({ where: { id: changeSetId, wikiId } })
  }

  async seqAt(wikiId: string, at: Date): Promise<number> {
    const row = await prisma.wikiChangeSet.aggregate({
      where: { wikiId, seq: { not: null }, appliedAt: { lte: at } },
      _max: { seq: true },
    })
    return row._max.seq ?? 0
  }

  async latestSeq(wikiId: string): Promise<number> {
    const wiki = await prisma.agentWiki.findUnique({ where: { id: wikiId }, select: { nextSeq: true } })
    return wiki ? wiki.nextSeq - 1 : 0
  }

  async appliedAtForSeq(wikiId: string, seq: number): Promise<Date | null> {
    const row = await prisma.wikiChangeSet.findUnique({ where: { wikiId_seq: { wikiId, seq } }, select: { appliedAt: true } })
    return row?.appliedAt ?? null
  }

  revisionsForChangeSet(changeSetId: string): Promise<WikiPageRevision[]> {
    return prisma.wikiPageRevision.findMany({ where: { changeSetId }, orderBy: { createdAt: 'asc' } })
  }

  findRevision(connectorId: string, pageId: string, version: number): Promise<WikiPageRevision | null> {
    return prisma.wikiPageRevision.findFirst({ where: { pageId, version, page: { connectorId } } })
  }

  previousRevision(connectorId: string, pageId: string, version: number): Promise<WikiPageRevision | null> {
    return prisma.wikiPageRevision.findFirst({
      where: { pageId, version: { lt: version }, page: { connectorId } },
      orderBy: { version: 'desc' },
    })
  }

  findPageById(connectorId: string, pageId: string): Promise<WikiPage | null> {
    return prisma.wikiPage.findFirst({ where: { id: pageId, connectorId } })
  }

  async listRevisions(connectorId: string, pageId: string) {
    const rows = await prisma.wikiPageRevision.findMany({
      where: { pageId, page: { connectorId } },
      orderBy: { version: 'desc' },
      include: { changeSet: { select: { seq: true, logEntry: true } } },
    })
    return rows.map(({ changeSet, ...rev }) => ({
      ...rev,
      seq: changeSet?.seq ?? null,
      changeSetLogTitle: logTitle(changeSet?.logEntry),
    }))
  }

  async stateAt(wikiId: string, connectorId: string, seq: number): Promise<WikiStateRow[]> {
    // Change-set nélküli (régi, közvetlen) revízió: az időpontja dönt.
    const cutoff = await this.appliedAtForSeq(wikiId, seq)
    const rows = await prisma.$queryRaw<Array<{ id: string; seq: number | null }>>(Prisma.sql`
      SELECT DISTINCT ON (r.page_id) r.id, cs.seq
      FROM wiki_page_revisions r
      JOIN wiki_pages p ON p.id = r.page_id
      LEFT JOIN wiki_change_sets cs ON cs.id = r.change_set_id
      WHERE p.wiki_id = ${wikiId}::uuid
        AND p.connector_id = ${connectorId}::uuid
        AND (
          (cs.seq IS NOT NULL AND cs.seq <= ${seq})
          OR (r.change_set_id IS NULL AND ${cutoff}::timestamptz IS NOT NULL AND r.created_at <= ${cutoff}::timestamptz)
        )
      ORDER BY r.page_id, r.version DESC
    `)
    if (rows.length === 0) return []
    const seqs = new Map(rows.map((row) => [row.id, row.seq === null ? null : Number(row.seq)]))
    const revisions = await prisma.wikiPageRevision.findMany({
      where: { id: { in: rows.map((row) => row.id) } },
      include: { page: { select: { type: true, category: true, sourceRefs: true } } },
    })
    // A bevezetés előtti (backfill) revízió típusa NULL: a lap mostani típusát kapja.
    return revisions.map(({ page, ...rev }) => ({
      ...rev,
      ...(rev.type === null ? { type: page.type, category: page.category, sourceRefs: rev.sourceRefs ?? page.sourceRefs } : {}),
      seq: seqs.get(rev.id) ?? null,
    }))
  }

  // ---------------------------------------------------------------------------
  // Agent-cursor (§5.4)

  async getCursor(wikiId: string, agentId: string, userId: string): Promise<number | null> {
    const row = await prisma.wikiReadCursor.findUnique({ where: { wikiId_agentId_userId: { wikiId, agentId, userId } } })
    return row?.seenSeq ?? null
  }

  async advanceCursor(wikiId: string, agentId: string, userId: string, seq: number): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO wiki_read_cursors (wiki_id, agent_id, user_id, seen_seq, updated_at)
      VALUES (${wikiId}::uuid, ${agentId}::uuid, ${userId}::uuid, ${seq}, now())
      ON CONFLICT (wiki_id, agent_id, user_id)
      DO UPDATE SET seen_seq = GREATEST(wiki_read_cursors.seen_seq, EXCLUDED.seen_seq), updated_at = now()
    `
  }

  // ---------------------------------------------------------------------------
  // Címkék (§5.5)

  listTags(wikiId: string): Promise<WikiTag[]> {
    return prisma.wikiTag.findMany({ where: { wikiId }, orderBy: { seq: 'desc' } })
  }

  async createTag(input: { wikiId: string; name: string; note: string | null; seq: number; createdByUserId: string }) {
    try {
      return await prisma.wikiTag.create({ data: input })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null
      throw error
    }
  }

  async deleteTag(wikiId: string, tagId: string): Promise<WikiTag | null> {
    const tag = await prisma.wikiTag.findFirst({ where: { id: tagId, wikiId } })
    if (!tag) return null
    await prisma.wikiTag.delete({ where: { id: tag.id } })
    return tag
  }

  // ---------------------------------------------------------------------------
  // Megőrzés (§6)

  updateRetention(wikiId: string, input: { retentionFullDays: number; retentionDeleteDays: number | null }): Promise<AgentWiki> {
    return prisma.agentWiki.update({ where: { id: wikiId }, data: input })
  }

  listWikisForRetention(input: { afterId?: string; limit: number }) {
    return prisma.agentWiki.findMany({
      where: input.afterId ? { id: { gt: input.afterId } } : {},
      select: { id: true, connectorId: true, retentionFullDays: true, retentionDeleteDays: true },
      orderBy: { id: 'asc' },
      take: input.limit,
    })
  }

  async sweepRetention(input: Parameters<WikiHistoryRepository['sweepRetention']>[0]): Promise<WikiRetentionCounts> {
    const { wikiId, fullBefore, deleteBefore, keepLatest, limit, now } = input
    return prisma.$transaction(async (tx) => {
      // Ugyanaz a zár, mint az írásnál: közben ne alkalmazódjon change-set.
      const wiki = await tx.agentWiki.findUnique({ where: { id: wikiId }, select: { connectorId: true } })
      if (!wiki) return { thinned: 0, deleted: 0, changeSetsPruned: 0 }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${wiki.connectorId}))`
      // Védett: aktuális verzió, oldalanként a legutóbbi N, címke-állapotok,
      // függő change-set baseVersion-je, sír-jelek (D1, D9).
      const protectedCte = Prisma.sql`
        revs AS (
          SELECT r.id, r.page_id, r.version, r.content_hash, r.created_at, r.erased_at,
                 p.version AS current_version,
                 ROW_NUMBER() OVER (PARTITION BY r.page_id ORDER BY r.version DESC) AS recency,
                 ROW_NUMBER() OVER (
                   PARTITION BY r.page_id, (r.created_at AT TIME ZONE 'Europe/Budapest')::date
                   ORDER BY r.version DESC
                 ) AS day_rank
          FROM wiki_page_revisions r
          JOIN wiki_pages p ON p.id = r.page_id
          WHERE p.wiki_id = ${wikiId}::uuid
        ),
        tagged AS (
          SELECT DISTINCT ON (t.id, r.page_id) r.id
          FROM wiki_tags t
          JOIN wiki_change_sets cs ON cs.wiki_id = t.wiki_id AND cs.seq IS NOT NULL AND cs.seq <= t.seq
          JOIN wiki_page_revisions r ON r.change_set_id = cs.id
          WHERE t.wiki_id = ${wikiId}::uuid
          ORDER BY t.id, r.page_id, r.version DESC
        ),
        pending_bases AS (
          SELECT DISTINCT e->>'baseVersion' AS hash
          FROM wiki_change_sets cs, jsonb_array_elements(CASE WHEN jsonb_typeof(cs.pages) = 'array' THEN cs.pages ELSE '[]'::jsonb END) e
          WHERE cs.wiki_id = ${wikiId}::uuid AND cs.status = 'pending' AND e ? 'baseVersion'
        ),
        candidates AS (
          SELECT revs.* FROM revs
          WHERE revs.version <> revs.current_version
            AND revs.recency > ${keepLatest}
            AND revs.erased_at IS NULL
            AND revs.id NOT IN (SELECT id FROM tagged)
            AND revs.content_hash NOT IN (SELECT hash FROM pending_bases WHERE hash IS NOT NULL)
        )`
      const deleted = deleteBefore
        ? await tx.$executeRaw(Prisma.sql`
            WITH ${protectedCte}
            DELETE FROM wiki_page_revisions WHERE id IN (
              SELECT id FROM candidates WHERE created_at < ${deleteBefore} ORDER BY created_at LIMIT ${limit}
            )`)
        : 0
      const thinned = await tx.$executeRaw(Prisma.sql`
        WITH ${protectedCte}
        DELETE FROM wiki_page_revisions WHERE id IN (
          SELECT id FROM candidates
          WHERE created_at < ${fullBefore}
            ${deleteBefore ? Prisma.sql`AND created_at >= ${deleteBefore}` : Prisma.empty}
            AND day_rank > 1
          ORDER BY created_at LIMIT ${Math.max(limit - deleted, 0)}
        )`)
      // A régi change-setekből csak az útvonal, a művelet és a cím marad (§6/4).
      const changeSetsPruned = await tx.$executeRaw(Prisma.sql`
        UPDATE wiki_change_sets SET
          pages = COALESCE((
            SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'path', e->'path', 'action', e->'action', 'title', e->'title', 'newPath', e->'newPath'
            )))
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(pages) = 'array' THEN pages ELSE '[]'::jsonb END) e
          ), '[]'::jsonb),
          pages_pruned_at = ${now}
        WHERE id IN (
          SELECT id FROM wiki_change_sets
          WHERE wiki_id = ${wikiId}::uuid
            AND status IN ('applied', 'rejected', 'reverted')
            AND pages_pruned_at IS NULL
            AND COALESCE(applied_at, created_at) < ${fullBefore}
          LIMIT ${limit}
        )`)
      return { thinned, deleted, changeSetsPruned }
    })
  }

  // ---------------------------------------------------------------------------
  // GDPR-törlés (§7)

  async findTextMatches(wikiId: string, connectorId: string, phrase: string) {
    const needle = phrase.toLowerCase()
    const like = Prisma.sql`position(${needle} in lower`
    const [pageIds, revisionIds, changeSetIds, logIds, documents, chunkCount, gatewayOperations] = await Promise.all([
      prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM wiki_pages WHERE wiki_id = ${wikiId}::uuid AND connector_id = ${connectorId}::uuid
          AND (${like}(path)) > 0 OR ${like}(title)) > 0 OR ${like}(summary)) > 0 OR ${like}(body)) > 0
               OR ${like}(frontmatter::text)) > 0 OR ${like}(COALESCE(category, ''))) > 0
               OR ${like}(source_refs::text)) > 0)`),
      prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT r.id FROM wiki_page_revisions r JOIN wiki_pages p ON p.id = r.page_id
        WHERE p.wiki_id = ${wikiId}::uuid AND p.connector_id = ${connectorId}::uuid AND r.erased_at IS NULL
          AND (${like}(r.title)) > 0 OR ${like}(r.summary)) > 0 OR ${like}(r.body)) > 0
               OR ${like}(r.frontmatter::text)) > 0 OR ${like}(COALESCE(r.path, ''))) > 0
               OR ${like}(COALESCE(r.category, ''))) > 0 OR ${like}(r.source_refs::text)) > 0)`),
      prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM wiki_change_sets WHERE wiki_id = ${wikiId}::uuid AND connector_id = ${connectorId}::uuid
          AND (${like}(pages::text)) > 0 OR ${like}(COALESCE(log_entry::text, ''))) > 0
               OR ${like}(COALESCE(page_summary::text, ''))) > 0 OR ${like}(COALESCE(validation::text, ''))) > 0)`),
      prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM wiki_log_entries WHERE wiki_id = ${wikiId}::uuid
          AND (${like}(title)) > 0 OR ${like}(COALESCE(note, ''))) > 0 OR ${like}(array_to_string(page_paths, ' '))) > 0)`),
      prisma.$queryRaw<Array<{ id: string; filename: string; extracted_text: string | null; has_source: boolean }>>(Prisma.sql`
        SELECT d.id, d.filename, d.extracted_text, (f.document_id IS NOT NULL) AS has_source
        FROM documents d LEFT JOIN document_source_files f ON f.document_id = d.id
        WHERE d.connector_id = ${connectorId}::uuid
          AND (${like}(d.filename)) > 0 OR ${like}(COALESCE(d.extracted_text, ''))) > 0)`),
      prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
        SELECT count(*) AS n FROM knowledge_chunks WHERE connector_id = ${connectorId}::uuid
          AND (${like}(text)) > 0 OR ${like}(title)) > 0 OR ${like}(path)) > 0)`),
      prisma.gatewayOperation.findMany({
        where: { connectorId, status: { in: [...OPEN_GATEWAY_STATUSES] } },
        select: { id: true, argsJson: true },
      }),
    ])
    const [pages, revisions, changeSets, logEntries] = await Promise.all([
      prisma.wikiPage.findMany({ where: { id: { in: pageIds.map((row) => row.id) } } }),
      prisma.wikiPageRevision.findMany({ where: { id: { in: revisionIds.map((row) => row.id) } }, orderBy: { version: 'desc' } }),
      prisma.wikiChangeSet.findMany({ where: { id: { in: changeSetIds.map((row) => row.id) } } }),
      prisma.wikiLogEntry.findMany({ where: { id: { in: logIds.map((row) => row.id) } } }),
    ])
    return {
      pages,
      revisions,
      changeSets,
      logEntries,
      documents: documents.map((row) => ({
        id: row.id,
        filename: row.filename,
        extractedText: row.extracted_text,
        hasSourceFile: row.has_source,
      })),
      chunks: Number(chunkCount[0]?.n ?? 0),
      gatewayOperations: gatewayOperations.filter((row) => JSON.stringify(row.argsJson).toLowerCase().includes(needle)),
    }
  }

  async listPageChangeSets(wikiId: string, pageIds: string[], paths: string[]): Promise<WikiChangeSet[]> {
    if (pageIds.length === 0) return []
    const ids = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT cs.id FROM wiki_change_sets cs WHERE cs.wiki_id = ${wikiId}::uuid AND (
        EXISTS (SELECT 1 FROM wiki_page_revisions r WHERE r.change_set_id = cs.id AND r.page_id IN (${Prisma.join(pageIds.map((id) => Prisma.sql`${id}::uuid`))}))
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(cs.pages) = 'array' THEN cs.pages ELSE '[]'::jsonb END) p
          WHERE p->>'path' IN (${Prisma.join(paths)}) OR p->>'newPath' IN (${Prisma.join(paths)})
            OR p->'restore'->>'path' IN (${Prisma.join(paths)})
        )
      )`)
    return prisma.wikiChangeSet.findMany({ where: { wikiId, id: { in: ids.map((row) => row.id) } } })
  }

  async listSourceDocuments(connectorId: string, documentIds: string[]) {
    const rows = await prisma.document.findMany({
      where: { connectorId, id: { in: documentIds } },
      select: { id: true, filename: true, sourceFile: { select: { documentId: true } } },
    })
    return rows.map(({ sourceFile, ...doc }) => ({ ...doc, hasSourceFile: !!sourceFile }))
  }

  listLogEntriesForPaths(wikiId: string, paths: string[]) {
    if (paths.length === 0) return Promise.resolve([])
    return prisma.wikiLogEntry.findMany({ where: { wikiId, pagePaths: { hasSome: paths } } })
  }

  listPendingGatewayOperations(connectorId: string) {
    return prisma.gatewayOperation.findMany({
      where: { connectorId, status: { in: [...OPEN_GATEWAY_STATUSES] } },
      select: { id: true, argsJson: true },
    })
  }

  async executeErasure(input: WikiErasureWrite) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.connectorId}))`
        const erasure = await tx.wikiErasure.create({
          data: {
            wikiId: input.wikiId,
            connectorId: input.connectorId,
            requestedBy: input.requestedBy,
            reason: input.reason,
            scope: input.scope,
            counts: {},
            erasedHashes: input.erasedHashes,
          },
          select: { id: true },
        })
        const counts: Record<string, number> = {}

        // 1) Az aktuális oldalak új verziója: szintetikus change-set (D7) sorszámmal.
        let changeSetId: string | null = null
        let seq: number | null = null
        if (input.pageWrites.length > 0) {
          const [allocated] = await tx.$queryRaw<Array<{ seq: number }>>`
            UPDATE agent_wikis SET next_seq = next_seq + 1
            WHERE id = ${input.wikiId}::uuid AND connector_id = ${input.connectorId}::uuid
            RETURNING next_seq - 1 AS seq
          `
          if (!allocated) throw new ErasureAborted()
          seq = Number(allocated.seq)
          const changeSet = await tx.wikiChangeSet.create({
            data: {
              wikiId: input.wikiId,
              connectorId: input.connectorId,
              userId: input.log.actorUserId,
              status: 'applied',
              appliedAt: input.appliedAt,
              seq,
              // A szintetikus change-set nem őriz tartalmat.
              pages: input.pageWrites.map((write) => ({ path: write.page.path, action: 'erase' })),
              logEntry: { op: 'note', title: input.log.title },
              approverScope: {},
              pagesPrunedAt: input.appliedAt,
            },
            select: { id: true },
          })
          changeSetId = changeSet.id
          const container = await tx.knowledgeArtifact.findFirst({
            where: { connectorId: input.connectorId, format: 'llm_wiki' },
            select: { id: true },
          })
          const written: WikiPage[] = []
          for (const write of input.pageWrites) {
            const updated = await tx.wikiPage.updateMany({
              where: { id: write.pageId, connectorId: input.connectorId, version: write.expectedVersion },
              data: {
                path: write.page.path,
                type: write.page.type,
                title: write.page.title,
                summary: write.page.summary,
                category: write.page.category ?? null,
                frontmatter: write.page.frontmatter ?? {},
                body: write.page.body,
                sourceRefs: write.page.sourceRefs ?? [],
                outLinks: write.page.outLinks ?? [],
                status: write.page.status ?? 'published',
                contentHash: write.page.contentHash,
                version: { increment: 1 },
              },
            })
            if (updated.count === 0) throw new ErasureAborted()
            const page = await tx.wikiPage.findUniqueOrThrow({ where: { id: write.pageId } })
            if (container) {
              await tx.knowledgeChunk.deleteMany({
                where: { artifactId: container.id, path: { in: [write.previousPath, page.path] } },
              })
              if (write.chunks.length > 0) {
                await tx.knowledgeChunk.createMany({
                  data: write.chunks.map((chunk) => ({
                    ...chunk,
                    sourceRef: chunk.sourceRef ?? undefined,
                    artifactId: container.id,
                    connectorId: input.connectorId,
                  })),
                })
              }
            }
            await tx.wikiPageRevision.create({ data: revisionData(page, changeSetId, input.log) })
            written.push(page)
          }
          const summary: WikiChangeSetPageSummary[] = input.pageSummary.map((row, i) => ({
            ...row,
            pageId: written[i].id,
            version: written[i].version,
          }))
          await tx.wikiChangeSet.update({
            where: { id: changeSetId },
            data: { pageSummary: summary as unknown as Prisma.InputJsonValue },
          })
          await tx.wikiLogEntry.create({
            data: {
              wikiId: input.wikiId,
              op: 'note',
              title: input.log.title,
              note: input.log.note,
              pagePaths: written.map((page) => page.path),
              changeSetId,
              actorUserId: input.log.actorUserId,
            },
          })
          counts.currentPages = written.length
        }

        // 2) Régi verziók: sír-jel vagy kitakarás.
        counts.tombstonedRevisions = 0
        for (const id of input.tombstoneRevisionIds) {
          const result = await tx.wikiPageRevision.updateMany({
            where: { id, page: { connectorId: input.connectorId } },
            data: {
              title: '',
              summary: '',
              body: '',
              frontmatter: {},
              sourceRefs: Prisma.DbNull,
              category: null,
              erasedAt: input.appliedAt,
              erasureId: erasure.id,
              ...(input.tombstonePaths?.[id] ? { path: input.tombstonePaths[id] } : {}),
            },
          })
          counts.tombstonedRevisions += result.count
        }
        counts.redactedRevisions = 0
        for (const row of input.redactRevisions) {
          const result = await tx.wikiPageRevision.updateMany({
            where: { id: row.id, page: { connectorId: input.connectorId } },
            data: {
              title: row.title,
              summary: row.summary,
              body: row.body,
              category: row.category,
              sourceRefs: row.sourceRefs,
              frontmatter: row.frontmatter,
              contentHash: row.contentHash,
              erasureId: erasure.id,
              ...(row.path !== undefined ? { path: row.path } : {}),
            },
          })
          counts.redactedRevisions += result.count
        }

        // 3) Másolatok: change-set tartalom, napló, nyers forrás, index, gateway-argumentum.
        for (const row of input.changeSets) {
          await tx.wikiChangeSet.updateMany({
            where: { id: row.id, wikiId: input.wikiId },
            data: {
              ...(row.pages !== undefined ? { pages: row.pages } : {}),
              ...(row.reject ? { status: 'rejected' } : {}),
              ...(row.pageSummary !== undefined ? { pageSummary: row.pageSummary } : {}),
              ...(row.logEntry !== undefined ? { logEntry: row.logEntry } : {}),
              ...(row.validation !== undefined ? { validation: row.validation } : {}),
            },
          })
        }
        counts.changeSets = input.changeSets.length
        for (const row of input.logEntries) {
          await tx.wikiLogEntry.updateMany({
            where: { id: row.id, wikiId: input.wikiId },
            data: { title: row.title, note: row.note, pagePaths: row.pagePaths },
          })
        }
        counts.logEntries = input.logEntries.length
        for (const row of input.documents.redact) {
          await tx.document.updateMany({
            where: { id: row.id, connectorId: input.connectorId },
            data: { filename: row.filename, extractedText: row.extractedText },
          })
          // Az eredeti fájl nem takarható ki: törlődik, a kinyert szöveg marad.
          await tx.documentSourceFile.deleteMany({ where: { documentId: row.id } })
        }
        counts.documentsRedacted = input.documents.redact.length
        if (input.documents.delete.length > 0) {
          await tx.knowledgeArtifact.deleteMany({
            where: { connectorId: input.connectorId, sourceDocumentId: { in: input.documents.delete } },
          })
          counts.documentsDeleted = (
            await tx.document.deleteMany({ where: { id: { in: input.documents.delete }, connectorId: input.connectorId } })
          ).count
        } else {
          counts.documentsDeleted = 0
        }
        counts.chunks = input.chunkPattern
          ? await tx.$executeRaw(Prisma.sql`
              UPDATE knowledge_chunks SET
                text = regexp_replace(text, ${input.chunkPattern}, '[törölve]', 'gi'),
                title = regexp_replace(title, ${input.chunkPattern}, '[törölve]', 'gi')
              WHERE connector_id = ${input.connectorId}::uuid
                AND (text ~* ${input.chunkPattern} OR title ~* ${input.chunkPattern})`)
          : 0
        for (const row of input.gatewayOperations) {
          await tx.gatewayOperation.updateMany({
            where: { id: row.id, connectorId: input.connectorId },
            data: { argsJson: row.argsJson, ...(row.reject ? { status: 'rejected' } : {}) },
          })
        }
        counts.gatewayOperations = input.gatewayOperations.length

        await tx.wikiErasure.update({ where: { id: erasure.id }, data: { counts } })
        return { ok: true as const, erasureId: erasure.id, changeSetId, seq, counts }
      })
    } catch (error) {
      if (error instanceof ErasureAborted) return { ok: false as const, reason: 'conflict' as const }
      throw error
    }
  }
}

function logTitle(value: Prisma.JsonValue | undefined): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const title = (value as Record<string, unknown>).title
  return typeof title === 'string' ? title : null
}

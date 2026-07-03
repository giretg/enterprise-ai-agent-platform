import { Prisma } from '@prisma/client'
import type { KnowledgeArtifact, KnowledgeArtifactStatus, KnowledgeChunk } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  KnowledgeArtifactRepository,
  KnowledgeChunkRepository,
  KnowledgeChunkSearchHit,
  KnowledgeIndexEntry,
  KnowledgePageChunk,
} from '@/repositories/interfaces'

/**
 * A query → Postgres `to_tsquery('simple', …)` kifejezés. A tokeneket kisbetűsíti,
 * a nem-alfanumerikus jeleket eldobja, és prefix-illesztéssel (`:*`) VAGY-kapcsolja
 * — így a ragozott alak is illeszkedik a `simple` (nem-stemmelő) tsvectorhoz, a
 * legacy stem-megközelítéshez hasonló recall-lal. Az ékezeteket MEGTARTJA, mert a
 * `simple` config sem ékezettelenít (a két oldalnak egyeznie kell). Üres query → ''.
 */
export function toKbTsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
  const unique = [...new Set(terms)]
  return unique.map((t) => `${t}:*`).join(' | ')
}

/**
 * KB-v3 artifact-tár (Knowledge-Base-v3-OKF-Spec §8.3). A scope-kulcs a
 * `connectorId`; a retrieval SOHA nem szűr `createdByAgentId`-ra (D-B).
 */
export class PostgresKnowledgeArtifactRepository implements KnowledgeArtifactRepository {
  async findById(id: string): Promise<KnowledgeArtifact | null> {
    return prisma.knowledgeArtifact.findUnique({ where: { id } })
  }

  async create(
    data: Omit<KnowledgeArtifact, 'id' | 'createdAt' | 'publishedAt'> & {
      publishedAt?: Date | null
    },
  ): Promise<KnowledgeArtifact> {
    const { validationResult, ...rest } = data
    return prisma.knowledgeArtifact.create({
      data: { ...rest, validationResult: validationResult as Prisma.InputJsonValue },
    })
  }

  async update(
    id: string,
    data: Partial<
      Pick<
        KnowledgeArtifact,
        | 'status'
        | 'contentHash'
        | 'bundleRef'
        | 'validationResult'
        | 'reviewSummary'
        | 'approvedById'
        | 'publishedAt'
      >
    >,
  ): Promise<KnowledgeArtifact> {
    const { validationResult, ...rest } = data
    return prisma.knowledgeArtifact.update({
      where: { id },
      data: {
        ...rest,
        ...(validationResult !== undefined
          ? { validationResult: validationResult as Prisma.InputJsonValue }
          : {}),
      },
    })
  }

  async findByConnector(
    connectorId: string,
    status?: KnowledgeArtifactStatus,
  ): Promise<KnowledgeArtifact[]> {
    return prisma.knowledgeArtifact.findMany({
      where: { connectorId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
    })
  }

  async latestVersionForDocument(
    connectorId: string,
    sourceDocumentId: string,
  ): Promise<number> {
    const top = await prisma.knowledgeArtifact.findFirst({
      where: { connectorId, sourceDocumentId },
      orderBy: { version: 'desc' },
      select: { version: true },
    })
    return top?.version ?? 0
  }

  async publishedSourceDocumentIds(connectorIds: string[]): Promise<string[]> {
    if (connectorIds.length === 0) return []
    const rows = await prisma.knowledgeArtifact.findMany({
      where: {
        connectorId: { in: connectorIds },
        status: 'published',
        sourceDocumentId: { not: null },
      },
      select: { sourceDocumentId: true },
      distinct: ['sourceDocumentId'],
    })
    return rows
      .map((r) => r.sourceDocumentId)
      .filter((id): id is string => id !== null)
  }
}

export class PostgresKnowledgeChunkRepository implements KnowledgeChunkRepository {
  async createMany(chunks: Array<Omit<KnowledgeChunk, 'id' | 'createdAt'>>): Promise<number> {
    if (chunks.length === 0) return 0
    const data: Prisma.KnowledgeChunkCreateManyInput[] = chunks.map((chunk) => ({
      ...chunk,
      tags: chunk.tags as Prisma.InputJsonValue,
      metadata: chunk.metadata as Prisma.InputJsonValue,
      sourceRef: (chunk.sourceRef ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    }))
    const result = await prisma.knowledgeChunk.createMany({ data })
    return result.count
  }

  async findByArtifact(artifactId: string): Promise<KnowledgeChunk[]> {
    return prisma.knowledgeChunk.findMany({
      where: { artifactId },
      orderBy: { chunkIndex: 'asc' },
    })
  }

  async deleteByArtifact(artifactId: string): Promise<void> {
    await prisma.knowledgeChunk.deleteMany({ where: { artifactId } })
  }

  async searchChunks(params: {
    connectorIds: string[]
    query: string
    limit: number
  }): Promise<KnowledgeChunkSearchHit[]> {
    if (params.connectorIds.length === 0) return []
    const tsquery = toKbTsQuery(params.query)
    if (!tsquery) return []

    // Scope + full-text (§10): csak PUBLISHED artifact chunkjai (§14.1), a
    // GIN-indexelt `to_tsvector('simple', title || ' ' || text)` ellen. A score
    // `ts_rank` (nem cosine). A `connector_id`-alapú scope a D-B scope-kulcs.
    const rows = await prisma.$queryRaw<
      Array<{
        artifactId: string
        connectorId: string
        path: string
        title: string
        type: string
        section: string | null
        text: string
        sourceRef: Prisma.JsonValue | null
        score: number
      }>
    >(Prisma.sql`
      SELECT c.artifact_id   AS "artifactId",
             c.connector_id  AS "connectorId",
             c.path,
             c.title,
             c.type,
             c.section,
             c.text,
             c.source_ref    AS "sourceRef",
             ts_rank(
               to_tsvector('simple', coalesce(c.title, '') || ' ' || c.text),
               query
             )::float8       AS "score"
      FROM knowledge_chunks c
      JOIN knowledge_artifacts a ON a.id = c.artifact_id,
           to_tsquery('simple', ${tsquery}) query
      WHERE c.connector_id::text IN (${Prisma.join(params.connectorIds)})
        AND a.status = 'published'
        AND to_tsvector('simple', coalesce(c.title, '') || ' ' || c.text) @@ query
      ORDER BY "score" DESC, c.chunk_index ASC
      LIMIT ${params.limit}
    `)

    return rows.map((r) => ({
      artifactId: r.artifactId,
      connectorId: r.connectorId,
      path: r.path,
      title: r.title,
      type: r.type,
      section: r.section,
      text: r.text,
      sourceRef: r.sourceRef,
      score: Number(r.score),
    }))
  }

  async listIndex(params: {
    connectorIds: string[]
    pathPrefix?: string
  }): Promise<KnowledgeIndexEntry[]> {
    if (params.connectorIds.length === 0) return []

    // Scope + csak PUBLISHED artifact (§14.1); a `connectorId`-scope a D-B
    // scope-kulcs. Path-onként egy oldal: a legkisebb chunkIndexű chunk címe
    // az oldal címe (a `## Source` előtti első heading-szekció).
    const rows = await prisma.knowledgeChunk.findMany({
      where: {
        connectorId: { in: params.connectorIds },
        artifact: { status: 'published' },
        ...(params.pathPrefix ? { path: { startsWith: params.pathPrefix } } : {}),
      },
      select: {
        artifactId: true,
        connectorId: true,
        path: true,
        title: true,
        type: true,
        chunkIndex: true,
      },
      orderBy: [{ artifactId: 'asc' }, { path: 'asc' }, { chunkIndex: 'asc' }],
    })

    const seen = new Set<string>()
    const entries: KnowledgeIndexEntry[] = []
    for (const r of rows) {
      const key = `${r.artifactId}::${r.path}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({
        artifactId: r.artifactId,
        connectorId: r.connectorId,
        path: r.path,
        title: r.title,
        type: r.type,
      })
    }
    return entries
  }

  async getPageChunks(params: {
    connectorIds: string[]
    path: string
    artifactId?: string
  }): Promise<KnowledgePageChunk[]> {
    if (params.connectorIds.length === 0) return []

    const rows = await prisma.knowledgeChunk.findMany({
      where: {
        connectorId: { in: params.connectorIds },
        path: params.path,
        artifact: { status: 'published' },
        ...(params.artifactId ? { artifactId: params.artifactId } : {}),
      },
      orderBy: [{ artifactId: 'asc' }, { chunkIndex: 'asc' }],
    })

    return rows.map((r) => ({
      artifactId: r.artifactId,
      connectorId: r.connectorId,
      path: r.path,
      title: r.title,
      type: r.type,
      section: r.section,
      chunkIndex: r.chunkIndex,
      text: r.text,
      sourceRef: r.sourceRef,
    }))
  }
}

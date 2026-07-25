import { Prisma } from '@prisma/client'
import type { MemoryCandidate, MemoryChunk, MemoryVersion } from '@prisma/client'
import { prisma } from '@/lib/db'
import { toKbTsQuery } from './knowledge-repository'
import type {
  MemoryCandidateRepository,
  MemoryChunkRepository,
  MemoryChunkSearchHit,
  MemoryVersionRepository,
} from '@/repositories/interfaces'

/** A `$queryRaw`/`RETURNING *` sorok snake_case mezőneveket adnak — Prisma model camelCase. */
function mapMemoryChunkRow(row: Record<string, unknown>): MemoryChunk {
  const str = (key: string, alt?: string) => {
    const v = row[key] ?? (alt ? row[alt] : undefined)
    return v == null ? null : String(v)
  }
  const num = (key: string, alt?: string, fallback = 0) => {
    const v = row[key] ?? (alt ? row[alt] : undefined)
    return v == null ? fallback : Number(v)
  }
  const date = (key: string, alt?: string) => {
    const v = row[key] ?? (alt ? row[alt] : undefined)
    return v == null ? null : new Date(v as string | Date)
  }
  const tagList = row.tags
  return {
    id: String(row.id),
    memoryId: String(row.memoryId ?? row.memory_id),
    agentId: String(row.agentId ?? row.agent_id),
    tenantId: str('tenantId', 'tenant_id'),
    projectKey: String(row.projectKey ?? row.project_key),
    workstreamKey: str('workstreamKey', 'workstream_key'),
    type: String(row.type),
    path: String(row.path),
    title: String(row.title),
    section: str('section'),
    text: String(row.text),
    summary: str('summary'),
    tags: Array.isArray(tagList) ? tagList.map(String) : [],
    metadata: (row.metadata ?? null) as MemoryChunk['metadata'],
    status: String(row.status),
    salience: num('salience', undefined, 0.5),
    confidence: String(row.confidence ?? 'normal'),
    sourceRefs: (row.sourceRefs ?? row.source_refs ?? null) as MemoryChunk['sourceRefs'],
    evidence: str('evidence'),
    approvedBy: str('approvedBy', 'approved_by'),
    approvedAt: date('approvedAt', 'approved_at'),
    reviewAfter: date('reviewAfter', 'review_after'),
    expiresAt: date('expiresAt', 'expires_at'),
    supersedes: str('supersedes'),
    supersededBy: str('supersededBy', 'superseded_by'),
    retrievedCount: num('retrievedCount', 'retrieved_count'),
    usedInAnswerCount: num('usedInAnswerCount', 'used_in_answer_count'),
    userConfirmedHelpfulCount: num('userConfirmedHelpfulCount', 'user_confirmed_helpful_count'),
    userCorrectedCount: num('userCorrectedCount', 'user_corrected_count'),
    lastRetrievedAt: date('lastRetrievedAt', 'last_retrieved_at'),
    lastUsedAt: date('lastUsedAt', 'last_used_at'),
    lastValidatedAt: date('lastValidatedAt', 'last_validated_at'),
    // content_hash NOT NULL a sémában → non-null coerce (a nyers sorban mindig kitöltött).
    contentHash: String(row.contentHash ?? row.content_hash ?? ''),
    createdAt: date('createdAt', 'created_at') ?? new Date(0),
    updatedAt: date('updatedAt', 'updated_at') ?? new Date(0),
  }
}

/**
 * §9.1/§5.1.1 — memória-scope FTS repository, a KB `ts_rank` mintáját másolva
 * (`knowledge-repository.ts` `searchChunks`). A query→tsquery normalizálás
 * (`toKbTsQuery`) újrahasznosított — a `to_tsvector('simple', ...)` kifejezésnek
 * KARAKTERRE egyeznie kell a `0004_agent_memory` migráció `memory_chunks_fts_idx`
 * indexével, különben az index nem használódik.
 */
export class PostgresMemoryChunkRepository implements MemoryChunkRepository {
  async searchActive(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
    query: string
    limit: number
  }): Promise<MemoryChunkSearchHit[]> {
    const tsquery = toKbTsQuery(params.query)
    if (!tsquery) return []

    const rows = await prisma.$queryRaw<Array<MemoryChunk & { textRelevance: number }>>(Prisma.sql`
      SELECT c.*,
             ts_rank(
               to_tsvector('simple', coalesce(c.title, '') || ' ' || coalesce(c.summary, '') || ' ' || c.text),
               query
             )::float8 AS "textRelevance"
      FROM memory_chunks c,
           to_tsquery('simple', ${tsquery}) query
      WHERE c.memory_id::text = ${params.memoryId}
        AND c.project_key = ${params.projectKey}
        AND c.status = 'active'
        ${params.workstreamKey ? Prisma.sql`AND c.workstream_key = ${params.workstreamKey}` : Prisma.empty}
        AND to_tsvector('simple', coalesce(c.title, '') || ' ' || coalesce(c.summary, '') || ' ' || c.text) @@ query
      ORDER BY "textRelevance" DESC, c.updated_at DESC
      LIMIT ${params.limit}
    `)

    return rows.map((r) => {
      const { textRelevance, ...chunkRow } = r as Record<string, unknown> & { textRelevance: number }
      return {
        chunk: mapMemoryChunkRow(chunkRow),
        textRelevance: Number(textRelevance),
      }
    })
  }

  async listRecentActive(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
    limit: number
  }): Promise<MemoryChunk[]> {
    return prisma.memoryChunk.findMany({
      where: {
        memoryId: params.memoryId,
        projectKey: params.projectKey,
        status: 'active',
        ...(params.workstreamKey !== undefined ? { workstreamKey: params.workstreamKey } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: params.limit,
    })
  }

  async findActiveFocus(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
  }): Promise<MemoryChunk | null> {
    return prisma.memoryChunk.findFirst({
      where: {
        memoryId: params.memoryId,
        projectKey: params.projectKey,
        workstreamKey: params.workstreamKey ?? null,
        status: 'active',
        type: 'focus',
      },
      orderBy: { updatedAt: 'desc' },
    })
  }

  async listActiveByType(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
    type: string
    limit: number
  }): Promise<MemoryChunk[]> {
    return prisma.memoryChunk.findMany({
      where: {
        memoryId: params.memoryId,
        projectKey: params.projectKey,
        status: 'active',
        type: params.type,
        ...(params.workstreamKey !== undefined ? { workstreamKey: params.workstreamKey } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: params.limit,
    })
  }

  async markRetrieved(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return
    await prisma.memoryChunk.updateMany({
      where: { id: { in: chunkIds } },
      data: { retrievedCount: { increment: 1 }, lastRetrievedAt: new Date() },
    })
  }

  async findById(id: string): Promise<MemoryChunk | null> {
    return prisma.memoryChunk.findUnique({ where: { id } })
  }

  async create(data: {
    memoryId: string
    agentId: string
    tenantId: string | null
    projectKey: string
    workstreamKey: string | null
    type: string
    path: string
    title: string
    text: string
    summary: string | null
    tags: string[]
    salience: number
    confidence: string
    sourceRefs: unknown
    evidence: string | null
    approvedBy: string
    approvedAt: Date
    reviewAfter: Date | null
    expiresAt: Date | null
    supersedes: string | null
    contentHash: string
  }): Promise<MemoryChunk> {
    return prisma.memoryChunk.create({
      data: {
        ...data,
        sourceRefs: data.sourceRefs as Prisma.InputJsonValue,
      },
    })
  }

  async updateStatus(
    id: string,
    patch: { status: string; supersededBy?: string | null },
  ): Promise<MemoryChunk> {
    return prisma.memoryChunk.update({
      where: { id },
      data: {
        status: patch.status,
        ...(patch.supersededBy !== undefined ? { supersededBy: patch.supersededBy } : {}),
      },
    })
  }

  async listActiveIds(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
  }): Promise<string[]> {
    const rows = await prisma.memoryChunk.findMany({
      where: {
        memoryId: params.memoryId,
        projectKey: params.projectKey,
        status: 'active',
        ...(params.workstreamKey !== undefined ? { workstreamKey: params.workstreamKey } : {}),
      },
      select: { id: true },
    })
    return rows.map((r) => r.id)
  }

  async setStatusMany(ids: string[], status: string): Promise<void> {
    if (ids.length === 0) return
    await prisma.memoryChunk.updateMany({ where: { id: { in: ids } }, data: { status } })
  }

  async findByContentHash(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
    contentHash: string
  }): Promise<MemoryChunk | null> {
    return prisma.memoryChunk.findFirst({
      where: {
        memoryId: params.memoryId,
        projectKey: params.projectKey,
        contentHash: params.contentHash,
        ...(params.workstreamKey !== undefined ? { workstreamKey: params.workstreamKey } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    })
  }

  async demoteSalience(id: string, factor: number): Promise<MemoryChunk> {
    const rows = await prisma.$queryRaw<MemoryChunk[]>(Prisma.sql`
      UPDATE memory_chunks
      SET salience = GREATEST(salience * ${factor}::float8, 0.05)
      WHERE id::text = ${id}
      RETURNING *
    `)
    if (!rows[0]) throw new Error('chunk not found')
    return mapMemoryChunkRow(rows[0] as Record<string, unknown>)
  }
}

/**
 * §9.3/§10.1 (WP-8) — a `MemoryVersion` manifest-tábla repositoryja. A
 * verziószám globális per-memory (`training-service.ts` `aggregate(_max)`
 * mintáját követve), a "current" a scope legutóbbi sora (nincs `status`-alapú
 * jelölés a chunk-manifest ágon — az a legacy full-inject útvonal dolga marad).
 */
export class PostgresMemoryVersionRepository implements MemoryVersionRepository {
  async nextVersionNumber(memoryId: string): Promise<number> {
    const row = await prisma.memoryVersion.aggregate({
      where: { memoryId },
      _max: { version: true },
    })
    return (row._max.version ?? 0) + 1
  }

  async create(data: {
    memoryId: string
    version: number
    projectKey: string
    workstreamKey: string | null
    activeChunkIds: string[]
    changeSet: unknown
    sourceCandidateIds: string[]
    approvedById: string | null
  }): Promise<MemoryVersion> {
    return prisma.memoryVersion.create({
      data: {
        memoryId: data.memoryId,
        version: data.version,
        status: 'active',
        projectKey: data.projectKey,
        workstreamKey: data.workstreamKey,
        activeChunkIds: data.activeChunkIds as Prisma.InputJsonValue,
        changeSet: data.changeSet as Prisma.InputJsonValue,
        sourceCandidateIds: data.sourceCandidateIds as Prisma.InputJsonValue,
        approvedById: data.approvedById,
      },
    })
  }

  async findLatestForScope(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
  }): Promise<MemoryVersion | null> {
    return prisma.memoryVersion.findFirst({
      where: {
        memoryId: params.memoryId,
        projectKey: params.projectKey,
        ...(params.workstreamKey !== undefined ? { workstreamKey: params.workstreamKey } : {}),
      },
      orderBy: { version: 'desc' },
    })
  }

  async findByVersion(params: { memoryId: string; version: number }): Promise<MemoryVersion | null> {
    return prisma.memoryVersion.findUnique({
      where: { memoryId_version: { memoryId: params.memoryId, version: params.version } },
    })
  }

  async listForScope(params: {
    memoryId: string
    projectKey: string
    workstreamKey?: string | null
    limit: number
  }): Promise<MemoryVersion[]> {
    return prisma.memoryVersion.findMany({
      where: {
        memoryId: params.memoryId,
        projectKey: params.projectKey,
        ...(params.workstreamKey !== undefined ? { workstreamKey: params.workstreamKey } : {}),
      },
      orderBy: { version: 'desc' },
      take: params.limit,
    })
  }
}

export class PostgresMemoryCandidateRepository implements MemoryCandidateRepository {
  async create(
    data: Omit<MemoryCandidate, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<MemoryCandidate> {
    return prisma.memoryCandidate.create({
      data: {
        ...data,
        payload: data.payload as Prisma.InputJsonValue,
      },
    })
  }

  async findById(id: string): Promise<MemoryCandidate | null> {
    return prisma.memoryCandidate.findUnique({ where: { id } })
  }

  async listByRun(params: {
    memoryId: string
    proposedByRunId?: string | null
    proposedInThreadId?: string | null
    status?: string
    statuses?: string[]
    projectKey?: string
  }): Promise<MemoryCandidate[]> {
    const statusFilter = params.statuses?.length
      ? { status: { in: params.statuses } }
      : params.status
        ? { status: params.status }
        : {}
    return prisma.memoryCandidate.findMany({
      where: {
        memoryId: params.memoryId,
        ...(params.proposedByRunId ? { proposedByRunId: params.proposedByRunId } : {}),
        ...(params.proposedInThreadId ? { proposedInThreadId: params.proposedInThreadId } : {}),
        ...(params.projectKey ? { projectKey: params.projectKey } : {}),
        ...statusFilter,
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  async updateStatus(
    id: string,
    patch: {
      status: string
      approvedBy?: string | null
      approvedAt?: Date | null
      rejectedBy?: string | null
      rejectedAt?: Date | null
      ticketId?: string | null
      writeGateTokenId?: string | null
      payload?: unknown
    },
  ): Promise<MemoryCandidate> {
    const { payload, ...rest } = patch
    return prisma.memoryCandidate.update({
      where: { id },
      data: {
        ...rest,
        ...(payload !== undefined ? { payload: payload as Prisma.InputJsonValue } : {}),
      },
    })
  }
}

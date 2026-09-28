import { Prisma, type Document, type KnowledgeArtifact, type KnowledgeArtifactStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import { KB_SECTION_SPLIT_SQL, kbSectionForSegment, readKbPurpose, snippet } from '@/lib/kb-retrieval'
import type {
  DocumentListItem,
  DocumentRepository,
  KnowledgeArtifactRepository,
  KnowledgeCatalogDocument,
  KnowledgeChunkRepository,
  KnowledgeChunkSearchHit,
  KnowledgeIndexEntry,
  KnowledgePageChunk,
  KnowledgeRawHit,
} from '../interfaces'

/** A keresőkifejezés szavai: kisbetű, nem-betű/szám karakternél vágva, dedup, min. 2 karakter. */
export function kbQueryTerms(query: string): string[] {
  const seen = new Set<string>()
  for (const token of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 2) seen.add(token)
  }
  return [...seen]
}

export function toKbTsQuery(query: string): string {
  return kbQueryTerms(query)
    .map((token) => `${token}:*`)
    .join(' | ')
}

/**
 * Magyar szótövezés + stopszó-szűrés (Postgres `hungarian` snowball): a
 * „színkódot" a „színkód"-ot is megtalálja, a „hogyan/az/milyen" kiesik. A
 * `knowledge_chunks_fts_hu_idx` ugyanerre a kifejezésre épül.
 */
const KB_FTS_CONFIG = Prisma.sql`'hungarian'::regconfig`

/** A kérdésszavak közül azok, amelyek a szakaszban szerepelnek (IDF-újrarangsoroláshoz). */
function kbMatchedTermsSql(vector: Prisma.Sql, terms: string[]): Prisma.Sql {
  return Prisma.sql`ARRAY(
    SELECT t.term FROM unnest(${terms}::text[]) AS t(term)
    WHERE ${vector} @@ to_tsquery(${KB_FTS_CONFIG}, t.term || ':*')
  )`
}

/** Jelölt-sorrend: több fedett kérdésszó előbb, holtversenyben ts_rank. */
function kbCandidateOrderSql(vector: Prisma.Sql, terms: string[], tsquery: string): Prisma.Sql {
  return Prisma.sql`cardinality(${kbMatchedTermsSql(vector, terms)}) DESC,
    ts_rank(${vector}, to_tsquery(${KB_FTS_CONFIG}, ${tsquery})) DESC`
}

export class PostgresDocumentRepository implements DocumentRepository {
  async create(data: Parameters<DocumentRepository['create']>[0]): Promise<Document> {
    return prisma.document.create({
      data: {
        tenantId: data.tenantId,
        filename: data.filename,
        storageRef: data.storageRef ?? null,
        extractedText: data.extractedText ?? null,
        mimeType: data.mimeType ?? null,
        contentHash: data.contentHash ?? null,
        status: data.status ?? 'uploaded',
        processingMode: data.processingMode ?? null,
        metadata: data.metadata ?? {},
        connectorId: data.connectorId ?? null,
        uploadedById: data.uploadedById,
      },
    })
  }

  async findById(id: string): Promise<Document | null> {
    return prisma.document.findUnique({ where: { id } })
  }

  async findByConnectorId(connectorId: string): Promise<Document[]> {
    return prisma.document.findMany({
      where: { connectorId, status: 'processed' },
      orderBy: { createdAt: 'desc' },
    })
  }

  async listByConnectorId(connectorId: string): Promise<DocumentListItem[]> {
    const rows = await prisma.document.findMany({
      where: { connectorId },
      select: {
        id: true,
        filename: true,
        status: true,
        processingMode: true,
        mimeType: true,
        createdAt: true,
        connectorId: true,
        metadata: true,
      },
      orderBy: { createdAt: 'desc' },
    })
    return rows.map(({ metadata, ...row }) => ({ ...row, purpose: readKbPurpose(metadata) }))
  }

  async listCatalog(connectorId: string): Promise<KnowledgeCatalogDocument[]> {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string
        filename: string
        processing_mode: KnowledgeCatalogDocument['processingMode']
        metadata: Prisma.JsonValue
        chars: number
      }>
    >`
      SELECT id, filename, processing_mode, metadata,
             char_length(coalesce(extracted_text, ''))::int AS chars
      FROM documents
      WHERE connector_id = ${connectorId}::uuid
        AND status = CAST('processed' AS "DocumentStatus")
      ORDER BY filename ASC
    `
    return rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      processingMode: row.processing_mode,
      metadata: row.metadata,
      chars: Number(row.chars),
    }))
  }

  async searchRaw(connectorId: string, query: string, limit: number): Promise<KnowledgeRawHit[]> {
    const terms = kbQueryTerms(query)
    const tsquery = toKbTsQuery(query)
    if (!tsquery || limit <= 0) return []
    // Szakasz-szintű keresés: a raw fájl heading-szakaszai külön versenyeznek,
    // hogy egy hosszú fájl ne nyerjen pusztán a hossza miatt.
    // ponytail: sequential scan + futásidejű vágás; GIN/tárolt szakaszok, ha a raw korpusz nő.
    const vector = Prisma.sql`to_tsvector(${KB_FTS_CONFIG}, s.body)`
    const rows = await prisma.$queryRaw<
      Array<{
        id: string
        filename: string
        extracted_text: string
        ord: bigint
        snippet: string | null
        score: number
        matched: string[]
      }>
    >`
      SELECT d.id, d.filename, d.extracted_text, s.ord,
             ts_rank(${vector}, to_tsquery(${KB_FTS_CONFIG}, ${tsquery})) AS score,
             ${kbMatchedTermsSql(vector, terms)} AS matched,
             ts_headline(
               ${KB_FTS_CONFIG},
               s.body,
               to_tsquery(${KB_FTS_CONFIG}, ${tsquery}),
               'MaxWords=40, MinWords=12, MaxFragments=1, StartSel="", StopSel=""'
             ) AS snippet
      FROM documents d
      CROSS JOIN LATERAL regexp_split_to_table(coalesce(d.extracted_text, ''), ${KB_SECTION_SPLIT_SQL})
        WITH ORDINALITY AS s(body, ord)
      WHERE d.connector_id = ${connectorId}::uuid
        AND d.status = CAST('processed' AS "DocumentStatus")
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_artifacts a
          WHERE a.source_document_id = d.id
            AND a.status = CAST('published' AS "KnowledgeArtifactStatus")
        )
        AND ${vector} @@ to_tsquery(${KB_FTS_CONFIG}, ${tsquery})
      ORDER BY ${kbCandidateOrderSql(vector, terms, tsquery)}
      LIMIT ${limit}
    `
    return rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      section: kbSectionForSegment(row.extracted_text, Number(row.ord) - 1),
      snippet: snippet(row.snippet?.trim() || row.filename),
      score: Number(row.score),
      matched: row.matched,
    }))
  }

  async update(id: string, data: Parameters<DocumentRepository['update']>[1]): Promise<Document> {
    return prisma.document.update({ where: { id }, data })
  }

  async delete(id: string): Promise<void> {
    await prisma.document.delete({ where: { id } })
  }
}

export class PostgresKnowledgeArtifactRepository implements KnowledgeArtifactRepository {
  async create(data: Parameters<KnowledgeArtifactRepository['create']>[0]): Promise<KnowledgeArtifact> {
    return prisma.knowledgeArtifact.create({
      data: {
        ...data,
        validationResult: data.validationResult ?? undefined,
      },
    })
  }

  async findById(id: string): Promise<KnowledgeArtifact | null> {
    return prisma.knowledgeArtifact.findUnique({ where: { id } })
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

  async publishedSourceDocumentIds(connectorIds: string[]): Promise<Set<string>> {
    if (connectorIds.length === 0) return new Set()
    const rows = await prisma.knowledgeArtifact.findMany({
      where: {
        connectorId: { in: connectorIds },
        status: 'published',
        sourceDocumentId: { not: null },
      },
      select: { sourceDocumentId: true },
    })
    return new Set(rows.map((row) => row.sourceDocumentId).filter((id): id is string => Boolean(id)))
  }

  async deleteBySourceDocumentId(documentId: string): Promise<void> {
    await prisma.knowledgeArtifact.deleteMany({ where: { sourceDocumentId: documentId } })
  }
}

export class PostgresKnowledgeChunkRepository implements KnowledgeChunkRepository {
  async createMany(rows: Parameters<KnowledgeChunkRepository['createMany']>[0]): Promise<number> {
    if (rows.length === 0) return 0
    const result = await prisma.knowledgeChunk.createMany({
      data: rows.map((row) => ({
        ...row,
        sourceRef: row.sourceRef ?? undefined,
      })),
    })
    return result.count
  }

  async searchChunks(
    connectorIds: string[],
    query: string,
    limit: number,
  ): Promise<KnowledgeChunkSearchHit[]> {
    const terms = kbQueryTerms(query)
    const tsquery = toKbTsQuery(query)
    if (!tsquery || connectorIds.length === 0 || limit <= 0) return []
    const vector = Prisma.sql`to_tsvector(${KB_FTS_CONFIG}, coalesce(c.title, '') || ' ' || c.text)`
    const rows = await prisma.$queryRaw<
      Array<{
        artifact_id: string
        connector_id: string
        path: string
        title: string
        type: string
        section: string | null
        text: string
        source_ref: Prisma.JsonValue
        score: number
        matched: string[]
      }>
    >`
      SELECT c.artifact_id, c.connector_id, c.path, c.title, c.type, c.section, c.text, c.source_ref,
             ts_rank(${vector}, to_tsquery(${KB_FTS_CONFIG}, ${tsquery})) AS score,
             ${kbMatchedTermsSql(vector, terms)} AS matched
      FROM knowledge_chunks c
      INNER JOIN knowledge_artifacts a ON a.id = c.artifact_id
      WHERE c.connector_id IN (${Prisma.join(connectorIds.map((id) => Prisma.sql`${id}::uuid`))})
        AND a.status = CAST('published' AS "KnowledgeArtifactStatus")
        AND ${vector} @@ to_tsquery(${KB_FTS_CONFIG}, ${tsquery})
      ORDER BY ${kbCandidateOrderSql(vector, terms, tsquery)}
      LIMIT ${limit}
    `
    return rows.map((row) => ({
      artifactId: row.artifact_id,
      connectorId: row.connector_id,
      path: row.path,
      title: row.title,
      type: row.type,
      section: row.section,
      text: row.text,
      sourceRef: row.source_ref,
      score: Number(row.score),
      matched: row.matched,
    }))
  }

  async listIndex(
    connectorIds: string[],
    pathPrefix?: string,
    artifactId?: string,
  ): Promise<KnowledgeIndexEntry[]> {
    if (connectorIds.length === 0) return []
    const rows = await prisma.knowledgeChunk.findMany({
      where: {
        connectorId: { in: connectorIds },
        artifact: { status: 'published' },
        ...(pathPrefix ? { path: { startsWith: pathPrefix } } : {}),
        ...(artifactId ? { artifactId } : {}),
      },
      distinct: ['artifactId', 'path'],
      select: {
        artifactId: true,
        connectorId: true,
        path: true,
        title: true,
        type: true,
      },
      orderBy: { path: 'asc' },
    })
    return rows
  }

  async getPageChunks(
    connectorIds: string[],
    path: string,
    artifactId?: string,
  ): Promise<KnowledgePageChunk[]> {
    if (connectorIds.length === 0) return []
    return prisma.knowledgeChunk.findMany({
      where: {
        connectorId: { in: connectorIds },
        path,
        artifact: { status: 'published' },
        ...(artifactId ? { artifactId } : {}),
      },
      select: {
        artifactId: true,
        connectorId: true,
        path: true,
        title: true,
        type: true,
        section: true,
        chunkIndex: true,
        text: true,
        sourceRef: true,
      },
      orderBy: { chunkIndex: 'asc' },
    })
  }

  async deleteByArtifact(artifactId: string): Promise<void> {
    await prisma.knowledgeChunk.deleteMany({ where: { artifactId } })
  }
}

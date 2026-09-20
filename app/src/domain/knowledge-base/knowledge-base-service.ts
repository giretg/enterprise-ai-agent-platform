import { createHash } from 'node:crypto'
import type { Connector, KnowledgeProcessingMode } from '@prisma/client'
import type {
  AgentRepository,
  AuditRepository,
  ConnectorRepository,
  DocumentRepository,
  KnowledgeArtifactRepository,
  KnowledgeChunkRepository,
} from '@/repositories/interfaces'
import {
  ensureAgentKnowledgeBase,
  ensureCatalogKnowledgeBase,
  knowledgeBaseConnectorName,
  knowledgeCatalogConnectorName,
} from '@/lib/agent-knowledge-base'
import {
  extractStructured,
  toExtractionMetadata,
  EXTRACTION_METADATA_KEY,
  type StructuredExtraction,
} from '@/lib/kb-extraction'
import { assembleKbHits, assembleKbIndex, assembleKbPage } from '@/lib/kb-retrieval'
import { buildOkfBundle, chunkOkfBundle } from '@/lib/kb-v3'
import { validateOkfBundle } from '@/lib/kb-validator'

export const KB_MAX_FILE_BYTES = 10 * 1024 * 1024

export type KnowledgeBaseDeps = {
  documents: DocumentRepository
  artifacts: KnowledgeArtifactRepository
  chunks: KnowledgeChunkRepository
  agents: Pick<AgentRepository, 'findById' | 'upsertConnectorBinding'>
  connectors: Pick<ConnectorRepository, 'findByTenantTypeAndName' | 'create'>
  audit: Pick<AuditRepository, 'append'>
}

function sanitizeFilename(filename: string): string {
  const base = filename.replace(/^.*[/\\]/, '').trim()
  return base.slice(0, 255)
}

export class KnowledgeBaseService {
  constructor(private deps: KnowledgeBaseDeps) {}

  async ingest(input: {
    tenantId: string
    agentId: string
    uploadedById: string
    filename: string
    mimeType?: string | null
    buffer: Buffer
    processingMode: KnowledgeProcessingMode
  }) {
    if (input.buffer.byteLength === 0) throw new Error('File is empty')
    if (input.buffer.byteLength > KB_MAX_FILE_BYTES) throw new Error('File is too large')
    const filename = sanitizeFilename(input.filename)
    if (!filename) throw new Error('Invalid filename')

    const agent = await this.deps.agents.findById(input.agentId, input.tenantId)
    if (!agent) throw new Error('Agent not found')
    const connector = await ensureAgentKnowledgeBase(agent, this.deps)

    const extraction = await extractStructured({
      buffer: input.buffer,
      filename,
      mimeType: input.mimeType,
    })
    return this.store({
      tenantId: input.tenantId,
      connector,
      agentId: agent.id,
      uploadedById: input.uploadedById,
      filename,
      mimeType: input.mimeType,
      buffer: input.buffer,
      extraction,
      processingMode: input.processingMode,
    })
  }

  /** Közös katalógus-tár: ugyanaz a feldolgozás, mint az agent-saját, csak agent nélkül. */
  async ingestCatalog(input: {
    tenantId: string
    uploadedById: string
    filename: string
    mimeType?: string | null
    buffer: Buffer
    processingMode: KnowledgeProcessingMode
  }) {
    if (input.buffer.byteLength === 0) throw new Error('File is empty')
    if (input.buffer.byteLength > KB_MAX_FILE_BYTES) throw new Error('File is too large')
    const filename = sanitizeFilename(input.filename)
    if (!filename) throw new Error('Invalid filename')

    const connector = await ensureCatalogKnowledgeBase(input.tenantId, this.deps)
    const extraction = await extractStructured({
      buffer: input.buffer,
      filename,
      mimeType: input.mimeType,
    })
    return this.store({
      tenantId: input.tenantId,
      connector,
      agentId: null,
      uploadedById: input.uploadedById,
      filename,
      mimeType: input.mimeType,
      buffer: input.buffer,
      extraction,
      processingMode: input.processingMode,
    })
  }

  async listCatalogDocuments(input: { tenantId: string }) {
    const connector = await this.deps.connectors.findByTenantTypeAndName(
      input.tenantId,
      'knowledge_base',
      knowledgeCatalogConnectorName(),
    )
    if (!connector) return []
    return this.deps.documents.listByConnectorId(connector.id)
  }

  async deleteCatalogDocument(input: {
    tenantId: string
    documentId: string
    actorId: string
  }) {
    const connector = await this.deps.connectors.findByTenantTypeAndName(
      input.tenantId,
      'knowledge_base',
      knowledgeCatalogConnectorName(),
    )
    if (!connector) throw new Error('Document not found')
    const document = await this.deps.documents.findById(input.documentId)
    if (!document || document.tenantId !== input.tenantId) throw new Error('Document not found')
    if (document.connectorId !== connector.id) throw new Error('Document not found')
    await this.deps.artifacts.deleteBySourceDocumentId(document.id)
    await this.deps.documents.delete(document.id)
    await this.deps.audit.append({
      actorType: 'human',
      actorId: input.actorId,
      agentVersion: null,
      action: 'kb.document.deleted',
      targetType: 'document',
      targetId: document.id,
      modelUsed: null,
      inputRef: document.filename,
      outputRef: connector.id,
      policyDecision: 'deleted',
      metadata: { catalog: true },
      tenantId: input.tenantId,
    })
    return { deleted: true }
  }

  /**
   * Katalóguselem hozzákötése agenthez: a jóváhagyott szövegről másolat készül az
   * agent saját tárába (wiki módban az oldalak újjáépülnek). A katalógus-példány
   * változatlan marad — a másolat nem követi a későbbi katalógus-frissítést.
   */
  async attachCatalogDocumentToAgent(input: {
    tenantId: string
    agentId: string
    documentId: string
    actorId: string
  }) {
    const agent = await this.deps.agents.findById(input.agentId, input.tenantId)
    if (!agent) throw new Error('Agent not found')
    const catalogConnector = await this.deps.connectors.findByTenantTypeAndName(
      input.tenantId,
      'knowledge_base',
      knowledgeCatalogConnectorName(),
    )
    if (!catalogConnector) throw new Error('Document not found')
    const source = await this.deps.documents.findById(input.documentId)
    if (!source || source.tenantId !== input.tenantId) throw new Error('Document not found')
    if (source.connectorId !== catalogConnector.id) throw new Error('Document not found')
    if (!source.extractedText) throw new Error('A dokumentum szövege nem elérhető')

    const connector = await ensureAgentKnowledgeBase(agent, this.deps)
    const result = await this.store({
      tenantId: input.tenantId,
      connector,
      agentId: agent.id,
      uploadedById: input.actorId,
      filename: source.filename,
      mimeType: source.mimeType,
      buffer: Buffer.from(source.extractedText, 'utf8'),
      extraction: {
        format: 'text',
        markdown: source.extractedText,
        blocks: [],
      } satisfies StructuredExtraction,
      processingMode: (source.processingMode ?? 'raw_text_only') as KnowledgeProcessingMode,
    })
    await this.deps.audit.append({
      actorType: 'human',
      actorId: input.actorId,
      agentVersion: null,
      action: 'kb.catalog.attached',
      targetType: 'document',
      targetId: result.documentId,
      modelUsed: null,
      inputRef: source.id,
      outputRef: connector.id,
      policyDecision: 'allowed',
      metadata: { agentId: agent.id, catalogDocumentId: source.id },
      tenantId: input.tenantId,
    })
    return result
  }

  private async store(input: {
    tenantId: string
    connector: Connector
    agentId: string | null
    uploadedById: string
    filename: string
    mimeType?: string | null
    buffer: Buffer
    extraction: StructuredExtraction
    processingMode: KnowledgeProcessingMode
  }) {
    const { tenantId, connector, agentId, uploadedById, filename, extraction } = input
    const contentHash = createHash('sha256').update(input.buffer).digest('hex')
    const document = await this.deps.documents.create({
      tenantId,
      filename,
      extractedText: extraction.markdown,
      mimeType: input.mimeType ?? null,
      contentHash,
      status: 'processed',
      processingMode: input.processingMode,
      metadata: { [EXTRACTION_METADATA_KEY]: toExtractionMetadata(extraction) },
      connectorId: connector.id,
      uploadedById,
    })

    let artifactId: string | undefined
    let chunkCount = 0
    let pageCount = 0
    if (input.processingMode === 'okf') {
      const bundle = buildOkfBundle({
        filename,
        extractedText: extraction.markdown,
        connectorId: connector.id,
        sourceDocumentId: document.id,
        createdByAgentId: agentId ?? undefined,
        blocks: extraction.blocks,
      })
      const validation = validateOkfBundle(bundle, { connectorId: connector.id })
      const artifact = await this.deps.artifacts.create({
        connectorId: connector.id,
        sourceDocumentId: document.id,
        createdByAgentId: agentId ?? undefined,
        status: 'published',
        version: 1,
        contentHash: bundle.contentHash,
        bundle: { files: bundle.files, indexPath: bundle.indexPath },
        validationResult: validation as never,
        publishedAt: new Date(),
      })
      const chunks = chunkOkfBundle(bundle, { documentId: document.id, filename })
      chunkCount = await this.deps.chunks.createMany(
        chunks.map((chunk) => ({
          artifactId: artifact.id,
          connectorId: connector.id,
          path: chunk.path,
          title: chunk.title,
          type: chunk.type,
          section: chunk.section,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          sourceRef: (chunk.sourceRef ?? null) as never,
          contentHash: chunk.contentHash,
        })),
      )
      artifactId = artifact.id
      pageCount = bundle.files.filter((file) => file.path !== 'index.md').length
    }

    await this.deps.audit.append({
      actorType: 'human',
      actorId: uploadedById,
      agentVersion: null,
      action: 'kb.document.ingested',
      targetType: 'document',
      targetId: document.id,
      modelUsed: null,
      inputRef: filename,
      outputRef: connector.id,
      policyDecision: 'allowed',
      metadata: {
        agentId,
        processingMode: input.processingMode,
        artifactId: artifactId ?? null,
        chunkCount,
      },
      tenantId,
    })

    return {
      documentId: document.id,
      filename,
      processingMode: input.processingMode,
      artifactId: artifactId ?? null,
      chunkCount,
      pageCount,
      searchable: true,
    }
  }

  private async findOwnedConnector(tenantId: string, agentId: string) {
    const agent = await this.deps.agents.findById(agentId, tenantId)
    if (!agent) throw new Error('Agent not found')
    const connector = await this.deps.connectors.findByTenantTypeAndName(
      agent.tenantId,
      'knowledge_base',
      knowledgeBaseConnectorName(agent.id),
    )
    return { agent, connector }
  }

  async listDocuments(input: { tenantId: string; agentId: string }) {
    const { connector } = await this.findOwnedConnector(input.tenantId, input.agentId)
    if (!connector) return []
    return this.deps.documents.listByConnectorId(connector.id)
  }

  async deleteDocument(input: {
    tenantId: string
    agentId: string
    documentId: string
    actorId: string
  }) {
    const { agent, connector } = await this.findOwnedConnector(input.tenantId, input.agentId)
    if (!connector) throw new Error('Document not found')
    const document = await this.deps.documents.findById(input.documentId)
    if (!document || document.tenantId !== input.tenantId) throw new Error('Document not found')
    if (document.connectorId !== connector.id) throw new Error('Document not found')
    await this.deps.artifacts.deleteBySourceDocumentId(document.id)
    await this.deps.documents.delete(document.id)
    await this.deps.audit.append({
      actorType: 'human',
      actorId: input.actorId,
      agentVersion: null,
      action: 'kb.document.deleted',
      targetType: 'document',
      targetId: document.id,
      modelUsed: null,
      inputRef: document.filename,
      outputRef: connector.id,
      policyDecision: 'deleted',
      metadata: { agentId: agent.id },
      tenantId: input.tenantId,
    })
    return { deleted: true }
  }

  async search(input: { connectorId: string; query: string; k?: number }) {
    const k = Math.min(Math.max(input.k ?? 5, 1), 20)
    const connectorIds = [input.connectorId]
    const [okfChunkHits, docs, supersededDocIds] = await Promise.all([
      this.deps.chunks.searchChunks(connectorIds, input.query, k),
      this.deps.documents.findByConnectorId(input.connectorId),
      this.deps.artifacts.publishedSourceDocumentIds(connectorIds),
    ])
    return assembleKbHits({
      query: input.query,
      k,
      memoryContent: '',
      memoryId: null,
      memoryVersion: null,
      okfChunkHits,
      docs: docs.map((doc) => ({
        id: doc.id,
        filename: doc.filename,
        extractedText: doc.extractedText,
      })),
      supersededDocIds,
    })
  }

  async listIndex(input: { connectorId: string; pathPrefix?: string; maxDepth?: number }) {
    const entries = await this.deps.chunks.listIndex([input.connectorId], input.pathPrefix)
    return assembleKbIndex(entries, input.maxDepth)
  }

  async getPage(input: { connectorId: string; path: string; artifactId?: string }) {
    const chunks = await this.deps.chunks.getPageChunks(
      [input.connectorId],
      input.path,
      input.artifactId,
    )
    return assembleKbPage(input.path, chunks)
  }
}

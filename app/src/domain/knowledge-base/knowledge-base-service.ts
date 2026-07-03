import type {
  Agent,
  Connector,
  Document,
  KnowledgeArtifact,
  KnowledgeProcessingMode,
  Ticket,
  UserRole,
} from '@prisma/client'
import type {
  AgentRepository,
  AuditRepository,
  DocumentRepository,
  KnowledgeArtifactRepository,
  KnowledgeChunkRepository,
  TicketRepository,
} from '@/repositories/interfaces'
import { ensureAgentKnowledgeBase } from '@/lib/agent-knowledge-base'
import {
  buildOkfBundle,
  chunkOkfBundle,
  type OkfBundleFile,
  type OkfSourceRef,
} from '@/lib/kb-v3'
import { validateOkfBundle, type KbValidationResult } from '@/lib/kb-validator'
import { readExtractionBlocks } from '@/lib/kb-extraction'
import type { Prisma } from '@prisma/client'
import type { TicketService } from '../ticket/ticket-service'

type EnsureKnowledgeBase = (
  agent: Pick<Agent, 'id' | 'name' | 'role'>,
) => Promise<Connector | null>

/**
 * §9.3 / §4.6: a tudásbázis-frissítés jóváhagyott tanítási ticketen megy.
 * A KB-dokumentum a `training` tickettípust használja (a memóriától eltérő
 * altípus), `kind: 'kb_document'` diszkriminátorral — így nem keveredik a
 * memória-write-gate (TrainingService) jóváhagyásával.
 */
export const KB_DOCUMENT_TICKET_KIND = 'kb_document'

export type KbDocumentTicketPayload = {
  kind: typeof KB_DOCUMENT_TICKET_KIND
  documentId: string
  connectorId: string
  filename: string
}

/** Visszaadja a KB-dokumentum payloadot, ha a ticket valóban KB-jóváhagyás. */
export function asKbDocumentPayload(payload: Ticket['payload']): KbDocumentTicketPayload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const candidate = payload as Record<string, unknown>
  if (candidate.kind !== KB_DOCUMENT_TICKET_KIND) return null
  if (typeof candidate.documentId !== 'string') return null
  if (typeof candidate.connectorId !== 'string') return null
  return {
    kind: KB_DOCUMENT_TICKET_KIND,
    documentId: candidate.documentId,
    connectorId: candidate.connectorId,
    filename: typeof candidate.filename === 'string' ? candidate.filename : 'dokumentum',
  }
}

export class KnowledgeBaseService {
  constructor(
    private tickets: TicketRepository,
    private documents: DocumentRepository,
    private agents: AgentRepository,
    private audit: AuditRepository,
    private ticketService: TicketService,
    private artifacts: KnowledgeArtifactRepository,
    private chunks: KnowledgeChunkRepository,
    // Injektálható a teszteléshez; alapból a valós provisioning.
    private ensureKnowledgeBase: EnsureKnowledgeBase = ensureAgentKnowledgeBase,
  ) {}

  /**
   * Feltöltött (de még nem csatolt) dokumentumhoz jóváhagyási ticketet nyit.
   * A dokumentum csak a jóváhagyás után kerül a KB connectorba — addig a
   * kb_search nem találja meg.
   */
  async requestDocument(params: {
    agentId: string
    documentId: string
    createdById: string
    /** KB-v3 §7.2 — feldolgozási mód; alapból nyers szöveg. */
    processingMode?: KnowledgeProcessingMode
  }): Promise<Ticket> {
    const agent = await this.agents.findById(params.agentId)
    if (!agent) throw new Error('Agent not found')
    if (agent.role === 'orchestrator') {
      throw new Error('Orchestrator agents do not use a knowledge base')
    }

    const document = await this.documents.findById(params.documentId)
    if (!document) throw new Error('Document not found')
    if (document.connectorId) throw new Error('Document already attached to a knowledge base')

    const connector = await this.ensureKnowledgeBase(agent)
    if (!connector) throw new Error('Agent has no knowledge_base connector')

    const processingMode = params.processingMode ?? 'raw_text_only'
    // A módot a dokumentumon rögzítjük, hogy a jóváhagyáskor tudjuk, kell-e
    // OKF-artifactot publikálni (§7.2/§7.8).
    await this.documents.update(document.id, { processingMode })

    // OKF-mód: már a review-ticket nyitásakor legenerálunk egy draft artifactot,
    // hogy az approver tartalmat lásson (§7.5 — MVP determinisztikus, nem LLM).
    if (processingMode === 'okf') {
      await this.createDraftArtifact({
        document,
        connector,
        createdById: params.createdById,
        createdByAgentId: agent.id,
      })
    }

    const payload: KbDocumentTicketPayload = {
      kind: KB_DOCUMENT_TICKET_KIND,
      documentId: document.id,
      connectorId: connector.id,
      filename: document.filename,
    }

    const ticket = await this.tickets.create({
      type: 'training',
      title: `KB jóváhagyás: ${document.filename}`,
      state: 'backlog',
      assigneeType: 'human',
      assigneeId: null,
      agentId: params.agentId,
      payload,
      sourceDocumentId: document.id,
      executeAfter: null,
      dueBy: null,
      createdById: params.createdById,
    })

    // Az állapotgépen át vezetjük a jóváhagyási kapuig — minden lépés auditált.
    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'ready',
      actor: { type: 'system' },
    })
    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'in_progress',
      actor: { type: 'system' },
    })
    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'awaiting_human',
      actor: { type: 'system' },
    })

    const updated = await this.tickets.findById(ticket.id)
    return updated ?? ticket
  }

  /** Jóváhagyás: a dokumentum bekerül a KB connectorba és kereshetővé válik. */
  async approveDocument(params: {
    ticketId: string
    approverId: string
    approverRole: UserRole
  }): Promise<Document> {
    const ticket = await this.tickets.findById(params.ticketId)
    if (!ticket || ticket.type !== 'training') throw new Error('KB ticket not found')
    const payload = asKbDocumentPayload(ticket.payload)
    if (!payload) throw new Error('Not a KB document ticket')
    if (ticket.state !== 'awaiting_human') throw new Error('Ticket not awaiting approval')

    const updated = await this.documents.update(payload.documentId, {
      connectorId: payload.connectorId,
      status: 'processed',
    })

    // OKF-mód: a hozzá tartozó draft artifactot publikáljuk — chunk index épül,
    // és csak innentől kereshető (§7.8). A raw_text_only út változatlan.
    const pending = (await this.artifacts.findByConnector(payload.connectorId, 'pending_review'))
      .find((a) => a.sourceDocumentId === payload.documentId)
    if (pending) {
      await this.publishArtifact({
        artifactId: pending.id,
        approverId: params.approverId,
      })
    }

    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'approved',
      actor: { type: 'human', userId: params.approverId, role: params.approverRole },
    })
    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'done',
      actor: { type: 'system' },
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.approverId,
      agentVersion: null,
      action: 'kb.document.approved',
      targetType: 'document',
      targetId: payload.documentId,
      modelUsed: null,
      inputRef: ticket.id,
      outputRef: payload.connectorId,
      policyDecision: 'kb_document_approved',
      metadata: { filename: payload.filename, agentId: ticket.agentId },
    })

    return updated
  }

  /** Elutasítás: a dokumentum nem kerül be, `failed` státuszt kap. */
  async rejectDocument(params: {
    ticketId: string
    approverId: string
    approverRole: UserRole
  }): Promise<{ rejected: true }> {
    const ticket = await this.tickets.findById(params.ticketId)
    if (!ticket || ticket.type !== 'training') throw new Error('KB ticket not found')
    const payload = asKbDocumentPayload(ticket.payload)
    if (!payload) throw new Error('Not a KB document ticket')
    if (ticket.state !== 'awaiting_human') throw new Error('Ticket not awaiting approval')

    await this.documents.update(payload.documentId, { status: 'failed' })

    // OKF-mód: a draft artifact `failed` — nem publikálódik, nem indexelődik.
    const pending = (await this.artifacts.findByConnector(payload.connectorId, 'pending_review'))
      .find((a) => a.sourceDocumentId === payload.documentId)
    if (pending) {
      await this.artifacts.update(pending.id, { status: 'failed' })
    }

    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'rejected',
      actor: { type: 'human', userId: params.approverId, role: params.approverRole },
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.approverId,
      agentVersion: null,
      action: 'kb.document.rejected',
      targetType: 'document',
      targetId: payload.documentId,
      modelUsed: null,
      inputRef: ticket.id,
      outputRef: payload.connectorId,
      policyDecision: 'kb_document_rejected',
      metadata: { filename: payload.filename, agentId: ticket.agentId },
    })

    return { rejected: true }
  }

  /** Az agenthez tartozó, jóváhagyásra váró KB-dokumentum ticketek. */
  async listPendingDocuments(agentId: string): Promise<
    Array<{ ticketId: string; documentId: string; filename: string; createdAt: Date }>
  > {
    const tickets = await this.tickets.findMany({
      type: 'training',
      agentId,
      state: 'awaiting_human',
    })
    return tickets
      .map((ticket) => {
        const payload = asKbDocumentPayload(ticket.payload)
        if (!payload) return null
        return {
          ticketId: ticket.id,
          documentId: payload.documentId,
          filename: payload.filename,
          createdAt: ticket.createdAt,
        }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
  }

  // ── KB-v3 artifact flow (§11.1) ───────────────────────────────────────────

  /**
   * Draft OKF-artifact a forrásdokumentumból (§7.5). MVP-ben determinisztikus
   * (nem LLM); `pending_review` státuszt kap, approval előtt SOHA nem kereshető
   * (chunk csak publikáláskor keletkezik). Verzió: a doc korábbi verzióira +1.
   */
  private async createDraftArtifact(input: {
    document: Document
    connector: Connector
    createdById: string
    createdByAgentId: string | null
  }): Promise<KnowledgeArtifact> {
    const bundle = buildOkfBundle({
      filename: input.document.filename,
      extractedText: input.document.extractedText,
      connectorId: input.connector.id,
      sourceDocumentId: input.document.id,
      createdByAgentId: input.createdByAgentId,
      storageRef: input.document.storageRef,
      // §7.3 — a feltöltéskor kinyert formátumfüggő szeletek (PDF oldal / DOCX
      // section / XLSX cella). Régi dokumentumon null → heading-split fallback.
      blocks: readExtractionBlocks(input.document.metadata) ?? undefined,
    })

    // §7.6 — determinisztikus validáció a draft-on; az eredmény a
    // `validationResult`-be kerül, és a review UI (§12.2) mutatja. NEM blokkol —
    // az emberi review dönt (§7.7/D-F). A hard error-okat külön auditáljuk.
    const validation = validateOkfBundle(bundle, { connectorId: input.connector.id })

    const version =
      (await this.artifacts.latestVersionForDocument(input.connector.id, input.document.id)) + 1

    const artifact = await this.artifacts.create({
      tenantId: input.connector.tenantId,
      connectorId: input.connector.id,
      createdByAgentId: input.createdByAgentId,
      sourceDocumentId: input.document.id,
      format: 'okf_v0_1',
      status: 'pending_review',
      version,
      contentHash: bundle.contentHash,
      bundleRef: `kb/${input.connector.id}/${input.document.id}/v${version}`,
      generationModel: null,
      generationPromptHash: null,
      validationResult: validation as unknown as Prisma.JsonObject,
      reviewSummary: null,
      createdById: input.createdById,
      approvedById: null,
    })

    await this.audit.append({
      actorType: 'human',
      actorId: input.createdById,
      agentVersion: null,
      action: 'kb.artifact.generated',
      targetType: 'document',
      targetId: input.document.id,
      modelUsed: null,
      inputRef: input.document.id,
      outputRef: artifact.id,
      policyDecision: 'kb_artifact_draft',
      metadata: {
        connectorId: input.connector.id,
        artifactId: artifact.id,
        version,
        pageCount: validation.pageCount,
        brokenLinks: validation.brokenLinks,
        sourceLinkCoverage: validation.sourceLinkCoverage,
        warnings: validation.warnings,
        errors: validation.errors,
      },
    })

    // §13 — a strukturálisan sérült draftot külön jelezzük (a review UI így már a
    // listában látja, hogy figyelmeztetést igényel).
    if (!validation.ok) {
      await this.audit.append({
        actorType: 'human',
        actorId: input.createdById,
        agentVersion: null,
        action: 'kb.artifact.validation_failed',
        targetType: 'document',
        targetId: input.document.id,
        modelUsed: null,
        inputRef: input.document.id,
        outputRef: artifact.id,
        policyDecision: 'kb_artifact_validation_failed',
        metadata: {
          connectorId: input.connector.id,
          artifactId: artifact.id,
          errors: validation.errors,
          brokenLinks: validation.brokenLinks,
        },
      })
    }

    return artifact
  }

  /**
   * Publikálás (§7.8): a draft artifact `published`, chunk index épül (a chunk
   * a kereshető egység), a source ref oldal/section-szintű (§4.7). A bundle
   * determinisztikus, ezért a chunkoláshoz újraépítjük a forrás-szövegből.
   */
  async publishArtifact(params: {
    artifactId: string
    approverId: string
  }): Promise<KnowledgeArtifact> {
    const artifact = await this.artifacts.findById(params.artifactId)
    if (!artifact) throw new Error('Artifact not found')
    if (artifact.status !== 'pending_review') {
      throw new Error('Artifact not awaiting publish')
    }
    if (!artifact.sourceDocumentId) throw new Error('Artifact has no source document')

    const document = await this.documents.findById(artifact.sourceDocumentId)
    if (!document) throw new Error('Source document not found')

    const bundle = buildOkfBundle({
      filename: document.filename,
      extractedText: document.extractedText,
      connectorId: artifact.connectorId,
      sourceDocumentId: document.id,
      createdByAgentId: artifact.createdByAgentId,
      storageRef: document.storageRef,
      // A determinisztikus bundle-t a forrás-szövegből ÉS a tárolt formátumfüggő
      // szeletekből építjük újra — így a chunk source ref oldal/section/cella-szintű.
      blocks: readExtractionBlocks(document.metadata) ?? undefined,
    })
    const source: OkfSourceRef = { documentId: document.id, filename: document.filename }
    const okfChunks = chunkOkfBundle(bundle, source)

    // Idempotencia: republish esetén a régi chunkokat töröljük.
    await this.chunks.deleteByArtifact(artifact.id)
    await this.chunks.createMany(
      okfChunks.map((chunk) => ({
        tenantId: artifact.tenantId,
        artifactId: artifact.id,
        connectorId: artifact.connectorId,
        path: chunk.path,
        title: chunk.title,
        type: chunk.type,
        section: chunk.section,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        summary: null,
        tags: [] as unknown as Prisma.JsonValue,
        metadata: {} as Prisma.JsonObject,
        sourceRef: chunk.sourceRef as unknown as Prisma.JsonValue,
        contentHash: chunk.contentHash,
      })),
    )

    const published = await this.artifacts.update(artifact.id, {
      status: 'published',
      approvedById: params.approverId,
      publishedAt: new Date(),
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.approverId,
      agentVersion: null,
      action: 'kb.artifact.published',
      targetType: 'document',
      targetId: document.id,
      modelUsed: null,
      inputRef: artifact.id,
      outputRef: artifact.connectorId,
      policyDecision: 'kb_artifact_published',
      metadata: {
        connectorId: artifact.connectorId,
        artifactId: artifact.id,
        version: artifact.version,
        chunkCount: okfChunks.length,
      },
    })

    return published
  }

  /** Jóváhagyásra váró OKF-artifactok az agenthez linkelt KB-connectorokon. */
  async listPendingArtifacts(agentId: string): Promise<KnowledgeArtifact[]> {
    const agent = await this.agents.findById(agentId)
    if (!agent) throw new Error('Agent not found')
    const connector = await this.ensureKnowledgeBase(agent)
    if (!connector) return []
    return this.artifacts.findByConnector(connector.id, 'pending_review')
  }

  /**
   * §12.2 hárompaneles review adatai egy dokumentumhoz: a forrás extracted text,
   * a determinisztikusan újraépített OKF file-tree (preview), a friss validáció
   * és a hozzá tartozó jóváhagyási ticket. `null`, ha a dokumentum nem található
   * vagy nem az agent KB-jéhez tartozik.
   */
  async getArtifactReview(params: { agentId: string; documentId: string }): Promise<{
    filename: string
    processingMode: KnowledgeProcessingMode | null
    extractedText: string | null
    artifact: {
      id: string
      status: KnowledgeArtifact['status']
      version: number
      createdAt: Date
    } | null
    files: OkfBundleFile[]
    validation: KbValidationResult | null
    ticketId: string | null
  } | null> {
    const agent = await this.agents.findById(params.agentId)
    if (!agent) throw new Error('Agent not found')
    const connector = await this.ensureKnowledgeBase(agent)
    if (!connector) return null

    const document = await this.documents.findById(params.documentId)
    if (!document) return null

    // A dokumentumhoz tartozó (draft vagy publikált) artifact — a legfrissebb.
    const artifacts = await this.artifacts.findByConnector(connector.id)
    const artifact =
      artifacts
        .filter((a) => a.sourceDocumentId === document.id)
        .sort((a, b) => b.version - a.version)[0] ?? null

    // A jóváhagyási ticket (approve/reject a review UI-ból).
    const tickets = await this.tickets.findMany({
      type: 'training',
      agentId: params.agentId,
      state: 'awaiting_human',
    })
    const ticketId =
      tickets.find((t) => asKbDocumentPayload(t.payload)?.documentId === document.id)?.id ?? null

    // OKF-preview + friss validáció csak OKF-módban (raw_text_only → nincs bundle).
    let files: OkfBundleFile[] = []
    let validation: KbValidationResult | null = null
    if (document.processingMode === 'okf' || artifact) {
      const bundle = buildOkfBundle({
        filename: document.filename,
        extractedText: document.extractedText,
        connectorId: connector.id,
        sourceDocumentId: document.id,
        createdByAgentId: artifact?.createdByAgentId ?? agent.id,
        storageRef: document.storageRef,
        blocks: readExtractionBlocks(document.metadata) ?? undefined,
      })
      files = bundle.files
      validation = validateOkfBundle(bundle, { connectorId: connector.id })
    }

    return {
      filename: document.filename,
      processingMode: document.processingMode,
      extractedText: document.extractedText,
      artifact: artifact
        ? {
            id: artifact.id,
            status: artifact.status,
            version: artifact.version,
            createdAt: artifact.createdAt,
          }
        : null,
      files,
      validation,
      ticketId,
    }
  }
}

import type {
  AgentRepository,
  AuditRepository,
  MemoryCandidateRepository,
  MemoryChunkRepository,
} from '@/repositories/interfaces'
import { validateMemoryProposeInput, type MemoryProposeInput } from './memory-acceptance-policy'
import { scanMemoryContentForSecrets } from './memory-content-guard'
import { memoryCandidatesTotal } from '@/lib/observability/metrics'

export type MemoryProposeContext = {
  agentId: string
  agentVersion?: number | null
  actingTenantId: string | null
  projectKey: string
  ticketId?: string | null
  conversationId?: string | null
}

export type MemoryProposeServiceResult =
  | {
      ok: true
      candidateId: string
      status: 'proposed'
      // WP-5 — a chat-kártyához (§6.2), extra DB-round-trip nélkül: a candidate
      // már létrejött ezen a ponton, ezekből a mezőkből építhető a kártya.
      operation: string
      type: string | null
      title: string | null
      summary: string | null
      projectKey: string
      workstreamKey: string | null
      // §3.2/§16 S3 — lágy PII-figyelmeztetés (a jóváhagyó dönt; nem blokkol).
      piiWarning: string[]
    }
  | { ok: false; reason: string }

/**
 * agent-memory-persistent-cross-conversation-spec.md §6/§10.2 —
 * `MemoryProposalService`. WP-4 hatóköre: KIZÁRÓLAG T1 `MemoryCandidate` sort
 * hoz létre (`status: 'proposed'`) — a jóváhagyás/write-gate/T2-publikálás a
 * WP-6 feladata. A batch-kártya (§6.2) a WP-5 UI-réteg dolga; ez a service
 * csak a csoportosításhoz szükséges kulcsokat (`proposedByRunId`/
 * `proposedInThreadId`) rögzíti következetesen minden javaslaton.
 */
export class MemoryProposalService {
  constructor(
    private readonly agents: AgentRepository,
    private readonly candidates: MemoryCandidateRepository,
    private readonly chunks: MemoryChunkRepository,
    private readonly audit: AuditRepository,
  ) {}

  async proposeMemoryChange(
    ctx: MemoryProposeContext,
    rawInput: MemoryProposeInput,
  ): Promise<MemoryProposeServiceResult> {
    const accepted = validateMemoryProposeInput(rawInput)
    if (!accepted.ok) return { ok: false, reason: accepted.reason }
    const { normalized } = accepted

    // §3.2/§16 S3 — capture-idő content-guard: detektált secret/kulcs HARD-BLOCK
    // (a javaslat nem jön létre), lágy PII pedig figyelmeztetés a kártyán.
    const scan = scanMemoryContentForSecrets([
      normalized.title,
      normalized.summary,
      normalized.text,
      normalized.evidence,
      normalized.path,
    ])
    if (scan.secrets.length > 0) {
      memoryCandidatesTotal.inc({ status: 'blocked' })
      await this.audit.append({
        actorType: 'agent',
        actorId: ctx.agentId,
        agentVersion: ctx.agentVersion ?? null,
        action: 'memory.propose.blocked',
        targetType: 'memory_candidate',
        targetId: null,
        modelUsed: null,
        inputRef: `operation:${normalized.operation}`,
        outputRef: 'blocked:secret_detected',
        policyDecision: 'secret_detected',
        tenantId: ctx.actingTenantId,
        ticketId: ctx.ticketId ?? null,
        conversationId: ctx.conversationId ?? null,
        // Csak a kategória-címkék kerülnek auditba, SOHA a nyers találat (payload-guard).
        metadata: { agentId: ctx.agentId, operation: normalized.operation, categories: scan.secrets },
      })
      return { ok: false, reason: 'secret_detected' }
    }

    const agent = await this.agents.findById(ctx.agentId)
    if (!agent) return { ok: false, reason: 'agent_not_found' }
    const memoryId = agent.memoryId

    // §6.1 — a `focus`-típusnál a supersede-hez az aktuális aktív focus chunk
    // kell `supersedes`-ben. Ha az agent nem adta meg explicit (a retrieval
    // eredményéből), a DB-ből (source of truth) oldjuk fel — a scope-onként
    // legfeljebb-1-aktív-focus invariáns (§3.1) így akkor is tartható, ha az
    // agent kihagyta a mezőt.
    let supersedes = normalized.supersedes
    if (normalized.operation === 'create' && normalized.type === 'focus' && !supersedes) {
      const activeFocus = await this.chunks.findActiveFocus({
        memoryId,
        projectKey: ctx.projectKey,
        workstreamKey: normalized.workstreamKey,
      })
      supersedes = activeFocus?.id ?? null
    }

    const payload = {
      type: normalized.type ?? null,
      path: normalized.path,
      title: normalized.title,
      summary: normalized.summary,
      text: normalized.text,
      tags: normalized.tags,
      salienceHint: normalized.salienceHint,
      confidence: normalized.confidence,
      supersedes,
      reviewAfter: normalized.reviewAfter,
      expiresAt: normalized.expiresAt,
      sourceRefs: normalized.sourceRefs,
      evidence: normalized.evidence,
      reason: normalized.reason,
      workstreamKey: normalized.workstreamKey,
      piiWarning: scan.softPii,
    }

    const candidate = await this.candidates.create({
      memoryId,
      agentId: ctx.agentId,
      tenantId: ctx.actingTenantId,
      projectKey: ctx.projectKey,
      workstreamKey: normalized.workstreamKey,
      operation: normalized.operation,
      payload,
      status: 'proposed',
      proposedBy: 'agent',
      proposedByRunId: ctx.ticketId ?? null,
      proposedInThreadId: ctx.conversationId ?? null,
      ticketId: null,
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      writeGateTokenId: null,
    })
    memoryCandidatesTotal.inc({ status: 'proposed' })

    await this.audit.append({
      actorType: 'agent',
      actorId: ctx.agentId,
      agentVersion: ctx.agentVersion ?? null,
      action: 'memory.propose',
      targetType: 'memory_candidate',
      targetId: candidate.id,
      modelUsed: null,
      inputRef: `operation:${normalized.operation}`,
      outputRef: 'status:proposed',
      policyDecision: 'allowed',
      tenantId: ctx.actingTenantId,
      ticketId: ctx.ticketId ?? null,
      conversationId: ctx.conversationId ?? null,
      metadata: {
        agentId: ctx.agentId,
        memoryId,
        projectKey: ctx.projectKey,
        workstreamKey: normalized.workstreamKey,
        operation: normalized.operation,
        type: normalized.type ?? null,
        candidateId: candidate.id,
        supersedes,
      },
    })

    return {
      ok: true,
      candidateId: candidate.id,
      status: 'proposed',
      operation: normalized.operation,
      type: normalized.type ?? null,
      title: normalized.title,
      summary: normalized.summary,
      projectKey: ctx.projectKey,
      workstreamKey: normalized.workstreamKey,
      piiWarning: scan.softPii,
    }
  }
}

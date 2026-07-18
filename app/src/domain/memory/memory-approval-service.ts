import { decideAuthz } from '@/lib/iam-policy'
import { requiresEvalGate, resolveSelfEvolutionProfile } from '@/lib/self-evolution-profile'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'
import { computeDiffHash } from '@/lib/crypto/hash-chain'
import { detectPublishConflict } from './conflict-detection'
import { snapshotMemoryManifest } from './memory-versioning'
import {
  memoryCandidatesTotal,
  memoryConflictsTotal,
  memoryInlineApprovalsTotal,
  memoryTicketedTotal,
} from '@/lib/observability/metrics'
import type {
  AgentRepository,
  AuditRepository,
  MemoryCandidateRepository,
  MemoryChunkRepository,
  MemoryVersionRepository,
  RolePermissionRepository,
  TicketRepository,
} from '@/repositories/interfaces'
import type { UserRole } from '@prisma/client'
import type { TicketService } from '../ticket/ticket-service'
import type { WriteGateService } from '../writegate/write-gate-service'
import type { EvalService } from '../eval/eval-service'

/**
 * agent-memory-persistent-cross-conversation-spec.md §6.3/§9.4/§10.2 —
 * `MemoryApprovalService`. A `TrainingService.approveTraining` mintáját követi
 * candidate→chunk útra: jogosultsági elágazás (inline write-gate consume vs.
 * ticket), majd a T2 `MemoryChunk` írása. A maintenance/rollback (WP-8) és a
 * hash-egyezésű reaktiválás (dedup-anchor, G11) NEM ennek a körnek a hatóköre.
 */

type MemoryCandidatePayload = {
  type: string | null
  path: string | null
  title: string | null
  summary: string | null
  text: string | null
  tags: string[]
  salienceHint: 'normal' | 'high'
  confidence: 'low' | 'normal' | 'high'
  supersedes: string | null
  reviewAfter: string | null
  expiresAt: string | null
  sourceRefs: unknown
  evidence: string | null
  reason: string
  workstreamKey: string | null
}

export type MemoryApprovalResult =
  | { ok: true; outcome: 'approved'; chunkId: string }
  | { ok: true; outcome: 'ticketed'; ticketId: string }
  | { ok: true; outcome: 'rejected' }
  | { ok: true; outcome: 'modified' }
  | { ok: false; reason: string }

/**
 * A jóváhagyás authz-bemenete mindig a request AKTÍV tenant-kontextusából jön.
 * A legacy `User.tenantId` nem használható itt: egy felhasználó több tenantnak
 * is tagja lehet, illetve a superadmin assume-módban dolgozhat.
 */
export type MemoryApprovalActor = {
  id: string
  tenantId: string
  role: UserRole
}

const MEMORY_CANDIDATE_TICKET_KIND = 'memory_candidate'

function readPayload(raw: unknown): MemoryCandidatePayload {
  const p = (raw ?? {}) as Partial<MemoryCandidatePayload>
  return {
    type: p.type ?? null,
    path: p.path ?? null,
    title: p.title ?? null,
    summary: p.summary ?? null,
    text: p.text ?? null,
    tags: Array.isArray(p.tags) ? p.tags : [],
    salienceHint: p.salienceHint === 'high' ? 'high' : 'normal',
    confidence: p.confidence ?? 'normal',
    supersedes: p.supersedes ?? null,
    reviewAfter: p.reviewAfter ?? null,
    expiresAt: p.expiresAt ?? null,
    sourceRefs: p.sourceRefs ?? [],
    evidence: p.evidence ?? null,
    reason: p.reason ?? '',
    workstreamKey: p.workstreamKey ?? null,
  }
}

/** §9.4 — a candidate payload kanonikus, jelöléstől-független alakja a write-gate hasheléshez. */
function buildCanonicalContent(operation: string, payload: MemoryCandidatePayload): string {
  if (
    operation === 'archive' ||
    operation === 'delete_request' ||
    operation === 'demote' ||
    operation === 'refresh_needed' ||
    operation === 'conflict_review'
  ) {
    return `${operation}:${payload.supersedes ?? ''}`
  }
  return JSON.stringify({
    type: payload.type,
    path: payload.path,
    title: payload.title,
    summary: payload.summary ?? '',
    text: payload.text,
    tags: [...payload.tags].sort(),
  })
}

const CHUNK_AUDIT_ACTION_BY_OPERATION: Record<string, string> = {
  create: 'memory.chunk.created',
  update: 'memory.chunk.updated',
  supersede: 'memory.chunk.superseded',
  archive: 'memory.chunk.archived',
  delete_request: 'memory.chunk.deleted',
  demote: 'memory.chunk.demoted',
}
// §8.4 — ezeknél nincs chunk-mutáció (tisztán advisory), a `memory.candidate.approved`
// sor önmagában a review-rekord — nem írunk mellé egy megtévesztő `memory.chunk.*` sort.
const ADVISORY_ONLY_OPERATIONS = new Set(['refresh_needed', 'conflict_review'])

export class MemoryApprovalService {
  constructor(
    private readonly agents: AgentRepository,
    private readonly candidates: MemoryCandidateRepository,
    private readonly chunks: MemoryChunkRepository,
    private readonly audit: AuditRepository,
    private readonly writeGate: WriteGateService,
    private readonly evalService: EvalService,
    private readonly rolePermissions: RolePermissionRepository,
    private readonly tickets: TicketRepository,
    private readonly ticketService: TicketService,
    private readonly versions: MemoryVersionRepository,
  ) {}

  /** A chat-kártya "Jóváhagyom" gombja — §6.3 szerint elágazik inline/ticket között. */
  async approve(candidateId: string, actor: MemoryApprovalActor): Promise<MemoryApprovalResult> {
    const resolved = await this.resolveCandidateForActor(candidateId, actor, 'memory.inline_approve')
    if (!resolved.ok) return resolved.result
    const { candidate, agent } = resolved
    if (candidate.status !== 'proposed' && candidate.status !== 'modified') {
      return { ok: false, reason: `candidate_not_pending:${candidate.status}` }
    }

    const profile = resolveSelfEvolutionProfile(agent.selfEvolutionProfile)
    if (!profile.scope.includes('memory')) {
      await this.audit.append({
        actorType: 'human',
        actorId: actor.id,
        agentVersion: agent.currentVersion,
        action: 'user.authz.deny',
        targetType: 'memory_candidate',
        targetId: candidateId,
        modelUsed: null,
        inputRef: 'memory.inline_approve',
        outputRef: null,
        policyDecision: 'self_evolution_scope_excludes_memory',
        tenantId: candidate.tenantId,
        metadata: { candidateId, agentId: agent.id },
      })
      return { ok: false, reason: 'self_evolution_scope_excludes_memory' }
    }

    const payload = readPayload(candidate.payload)

    if (requiresEvalGate(profile)) {
      const activeEval = await this.evalService.findActiveForAgent(agent.id)
      if (!activeEval) return { ok: false, reason: 'eval_required_but_missing' }
      const canonicalContent = buildCanonicalContent(candidate.operation, payload)
      const evalRun = await this.evalService.run({
        evalId: activeEval.id,
        proposedContent: canonicalContent,
        agentVersion: agent.currentVersion,
        trigger: 'pre_training_approval',
      })
      if (!evalRun.passed) {
        await this.audit.append({
          actorType: 'human',
          actorId: actor.id,
          agentVersion: agent.currentVersion,
          action: 'memory.write.eval_blocked',
          targetType: 'memory_candidate',
          targetId: candidateId,
          modelUsed: null,
          inputRef: activeEval.id,
          outputRef: evalRun.id,
          policyDecision: `eval_failed:score=${evalRun.score.toFixed(2)}`,
          tenantId: candidate.tenantId,
          metadata: evalRun.details,
        })
        return { ok: false, reason: 'eval_failed' }
      }
    }

    const permissionKey = candidate.operation === 'delete_request' ? 'memory.delete_approve' : 'memory.inline_approve'
    const permEntry = await this.rolePermissions.findByKey(permissionKey)
    const canInline = decideAuthz({ status: 'active', role: actor.role }, permEntry?.minRole ?? null).allow

    // §6.3/§12.1 — a T2-írás HORGONYA a `memory.inline_approve` (delete-nél
    // `memory.delete_approve`) capability. Ha az aktor NEM hordozza, a jóváhagyás
    // ticketre kerül — FÜGGETLENÜL a self-evolution profil emberi-jóváhagyás
    // igényétől. Korábban a kapu csak `requiresHumanApproval(profile)` mellett
    // futott, így `eval_only`/`auto_after_eval` profilnál megkerülhető volt.
    if (!canInline) {
      await this.audit.append({
        actorType: 'human',
        actorId: actor.id,
        agentVersion: agent.currentVersion,
        action: 'user.authz.deny',
        targetType: 'memory_candidate',
        targetId: candidateId,
        modelUsed: null,
        inputRef: permissionKey,
        outputRef: 'routed_to_ticket',
        policyDecision: 'inline_approve_capability_missing',
        tenantId: candidate.tenantId,
        metadata: { candidateId, agentId: agent.id, permissionKey },
      })
      return this.ticket(candidateId, actor)
    }

    const chunkId = await this.performInlineWrite(candidate, payload, actor.id)
    memoryCandidatesTotal.inc({ status: 'approved' })
    memoryInlineApprovalsTotal.inc()
    return { ok: true, outcome: 'approved', chunkId }
  }

  /** Explicit "Ticketbe küldöm" — jogosultságtól függetlenül ticketet nyit. */
  async ticket(candidateId: string, actor: MemoryApprovalActor): Promise<MemoryApprovalResult> {
    const resolved = await this.resolveCandidateForActor(candidateId, actor, 'memory.ticket')
    if (!resolved.ok) return resolved.result
    const { candidate } = resolved
    if (candidate.status !== 'proposed' && candidate.status !== 'modified') {
      return { ok: false, reason: `candidate_not_pending:${candidate.status}` }
    }
    const payload = readPayload(candidate.payload)

    const created = await this.tickets.create({
      type: 'training',
      title: `Memória-javaslat: ${payload.title ?? candidate.operation}`,
      state: 'backlog',
      assigneeType: 'human',
      assigneeId: null,
      agentId: candidate.agentId,
      payload: {
        kind: MEMORY_CANDIDATE_TICKET_KIND,
        candidateId: candidate.id,
        operation: candidate.operation,
        type: payload.type,
        summary: payload.summary,
        projectKey: candidate.projectKey,
      },
      sourceDocumentId: null,
      executeAfter: null,
      dueBy: null,
      createdById: actor.id,
      tenantId: candidate.tenantId,
    })

    await this.ticketService.transition({ ticketId: created.id, toState: 'ready', actor: { type: 'system' } })
    await this.ticketService.transition({ ticketId: created.id, toState: 'in_progress', actor: { type: 'system' } })
    const ticket = await this.ticketService.transition({
      ticketId: created.id,
      toState: 'awaiting_human',
      actor: { type: 'system' },
    })

    await this.candidates.updateStatus(candidateId, { status: 'ticketed', ticketId: ticket.id })
    memoryCandidatesTotal.inc({ status: 'ticketed' })
    memoryTicketedTotal.inc()
    await this.audit.append({
      actorType: 'human',
      actorId: actor.id,
      agentVersion: null,
      action: 'memory.candidate.ticketed',
      targetType: 'memory_candidate',
      targetId: candidateId,
      modelUsed: null,
      inputRef: candidate.operation,
      outputRef: ticket.id,
      policyDecision: 'ticketed',
      tenantId: candidate.tenantId,
      ticketId: ticket.id,
      metadata: { candidateId, ticketId: ticket.id },
    })

    return { ok: true, outcome: 'ticketed', ticketId: ticket.id }
  }

  /** A generikus ticket-jóváhagyási UI hívja, ha a ticket `payload.kind === 'memory_candidate'`. */
  async approveTicketedCandidate(ticketId: string, actor: MemoryApprovalActor): Promise<MemoryApprovalResult> {
    const ticket = await this.tickets.findById(ticketId)
    if (!ticket || ticket.type !== 'training') return { ok: false, reason: 'ticket_not_found' }
    if (ticket.state !== 'awaiting_human') return { ok: false, reason: 'ticket_not_awaiting_approval' }
    const payloadKind =
      typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
        ? (ticket.payload as Record<string, unknown>).kind
        : undefined
    if (payloadKind !== MEMORY_CANDIDATE_TICKET_KIND) return { ok: false, reason: 'not_a_memory_candidate_ticket' }

    const candidateId = (ticket.payload as { candidateId: string }).candidateId
    if (ticket.tenantId !== actor.tenantId) return { ok: false, reason: 'ticket_not_found' }

    const resolved = await this.resolveCandidateForActor(candidateId, actor, 'memory.ticket_approve')
    if (!resolved.ok) return resolved.result
    const { candidate } = resolved
    if (candidate.status !== 'ticketed') return { ok: false, reason: `candidate_not_ticketed:${candidate.status}` }
    if (ticket.tenantId !== candidate.tenantId) return { ok: false, reason: 'ticket_not_found' }

    const payload = readPayload(candidate.payload)
    const chunkId = await this.performInlineWrite(candidate, payload, actor.id)
    memoryCandidatesTotal.inc({ status: 'approved' })

    await this.ticketService.transition({
      ticketId,
      toState: 'approved',
      actor: { type: 'human', userId: actor.id, role: actor.role },
    })
    await this.ticketService.transition({ ticketId, toState: 'done', actor: { type: 'system' } })

    return { ok: true, outcome: 'approved', chunkId }
  }

  async reject(candidateId: string, actor: MemoryApprovalActor, reason?: string): Promise<MemoryApprovalResult> {
    const resolved = await this.resolveCandidateForActor(candidateId, actor, 'memory.reject')
    if (!resolved.ok) return resolved.result
    const { candidate } = resolved
    if (candidate.status !== 'proposed' && candidate.status !== 'modified') {
      return { ok: false, reason: `candidate_not_pending:${candidate.status}` }
    }

    await this.candidates.updateStatus(candidateId, {
      status: 'rejected',
      rejectedBy: actor.id,
      rejectedAt: new Date(),
    })
    memoryCandidatesTotal.inc({ status: 'rejected' })
    await this.audit.append({
      actorType: 'human',
      actorId: actor.id,
      agentVersion: null,
      action: 'memory.candidate.rejected',
      targetType: 'memory_candidate',
      targetId: candidateId,
      modelUsed: null,
      inputRef: candidate.operation,
      outputRef: 'rejected',
      policyDecision: 'rejected',
      tenantId: candidate.tenantId,
      metadata: { candidateId, reason: reason ?? null },
    })
    return { ok: true, outcome: 'rejected' }
  }

  /** A kártya "Módosítom" gombja — a payload finomítása, a candidate `proposed` marad. */
  async modify(
    candidateId: string,
    actor: MemoryApprovalActor,
    patch: Partial<Pick<MemoryCandidatePayload, 'title' | 'summary' | 'text' | 'tags' | 'evidence' | 'reason'>>,
  ): Promise<MemoryApprovalResult> {
    const resolved = await this.resolveCandidateForActor(candidateId, actor, 'memory.modify')
    if (!resolved.ok) return resolved.result
    const { candidate } = resolved
    if (candidate.status !== 'proposed' && candidate.status !== 'modified') {
      return { ok: false, reason: `candidate_not_pending:${candidate.status}` }
    }

    const current = readPayload(candidate.payload)
    const nextPayload = { ...current, ...patch }
    await this.candidates.updateStatus(candidateId, { status: 'modified', payload: nextPayload })
    await this.audit.append({
      actorType: 'human',
      actorId: actor.id,
      agentVersion: null,
      action: 'memory.candidate.modified',
      targetType: 'memory_candidate',
      targetId: candidateId,
      modelUsed: null,
      inputRef: candidate.operation,
      outputRef: 'modified',
      policyDecision: 'modified',
      tenantId: candidate.tenantId,
      metadata: { candidateId, changedFields: Object.keys(patch) },
    })
    return { ok: true, outcome: 'modified' }
  }

  private async performInlineWrite(
    candidate: {
      id: string
      agentId: string
      memoryId: string
      tenantId: string | null
      projectKey: string
      workstreamKey: string | null
      operation: string
    },
    payload: MemoryCandidatePayload,
    actorId: string,
  ): Promise<string> {
    const canonicalContent = buildCanonicalContent(candidate.operation, payload)

    // A proposalban lévő cél-chunk ID egy nem megbízható modell-bemenet. Mielőtt
    // write-gate tokent fogyasztanánk, ugyanahhoz a memória/agent/tenant/projekt
    // scope-hoz kötjük; különben egy ismert idegen UUID cross-tenant T2-írást
    // eredményezhetne.
    if (payload.supersedes) {
      const target = await this.chunks.findById(payload.supersedes)
      if (
        !target ||
        target.memoryId !== candidate.memoryId ||
        target.agentId !== candidate.agentId ||
        target.tenantId !== candidate.tenantId ||
        target.projectKey !== candidate.projectKey ||
        target.workstreamKey !== candidate.workstreamKey
      ) {
        throw new Error('memory_target_not_found')
      }
    }

    // Az inline jóváhagyás write-gate eseményei a jóváhagyó emberhez és a candidate
    // tenantjához kötődnek — ez a governance-lánc "ki engedélyezte az írást" horgonya.
    const gateContext = {
      tenantId: candidate.tenantId,
      actorType: 'human' as const,
      actorId,
    }
    const gateToken = await this.writeGate.issue({
      memoryCandidateId: candidate.id,
      agentId: candidate.agentId,
      targetMemoryId: candidate.memoryId,
      proposedContent: canonicalContent,
      context: gateContext,
    })
    await this.writeGate.consume({
      tokenId: gateToken.id,
      actualProposedContent: canonicalContent,
      context: gateContext,
    })

    let resultChunkId: string
    const now = new Date()

    // §8.2 (WP-8) — maintenance-proposalok is a candidate→chunk úton mennek át:
    // `demote` a salience-t csökkenti, `refresh_needed`/`conflict_review` pedig
    // tisztán advisory (nincs chunk-mutáció, az audit sor MAGA a review-rekord).
    // `merge` szándékosan NINCS bekötve — a v1 determinisztikus maintenance-
    // generátor (§8.3) nem javasol ilyet (tartalom-szintézis modellt igényelne).
    if (candidate.operation === 'archive') {
      const target = payload.supersedes!
      await this.chunks.updateStatus(target, { status: 'archived' })
      resultChunkId = target
    } else if (candidate.operation === 'delete_request') {
      const target = payload.supersedes!
      await this.chunks.updateStatus(target, { status: 'deleted' })
      resultChunkId = target
    } else if (candidate.operation === 'demote') {
      const target = payload.supersedes!
      await this.chunks.demoteSalience(target, 0.5)
      resultChunkId = target
    } else if (candidate.operation === 'refresh_needed' || candidate.operation === 'conflict_review') {
      resultChunkId = payload.supersedes ?? candidate.id
    } else {
      // create / update / supersede — mindhárom új chunkot ír, opcionálisan
      // superseding a payload.supersedes-ben megjelölt korábbi chunkot.

      // §7.1 bullet 3 — publikálás-időben: ellentmond-e egy aktív, azonos
      // path/type chunknak `supersedes` nélkül. Nem blokkol (a human approver
      // már döntött), csak auditál.
      const scopeSiblings = await this.chunks.listActiveByType({
        memoryId: candidate.memoryId,
        projectKey: candidate.projectKey,
        workstreamKey: payload.workstreamKey,
        type: payload.type!,
        limit: 50,
      })
      const publishConflict = detectPublishConflict(
        { type: payload.type!, path: payload.path!, tags: payload.tags, supersedes: payload.supersedes },
        scopeSiblings.map((c) => ({
          id: c.id,
          type: c.type,
          path: c.path,
          tags: c.tags,
          status: c.status,
          supersedes: c.supersedes,
        })),
      )
      if (publishConflict) {
        memoryConflictsTotal.inc({ resolution: 'publish_flagged' })
        await this.audit.append({
          actorType: 'human',
          actorId,
          agentVersion: null,
          action: 'memory.conflict_detected',
          targetType: 'memory_candidate',
          targetId: candidate.id,
          modelUsed: null,
          inputRef: candidate.operation,
          outputRef: `conflict:${publishConflict.risk}`,
          policyDecision: 'allowed',
          tenantId: candidate.tenantId,
          metadata: { candidateId: candidate.id, conflict: publishConflict },
        })
      }

      // §9.1/G11 — rollback→re-capture ciklusban a hash-egyezésű, nem-aktív chunk
      // REAKTIVÁLÓDIK ahelyett, hogy duplikátum keletkezne. `deleted` (hard-delete
      // jóváhagyási út, Q4) szándékosan kimarad — az nem "csendben" állítható vissza.
      const contentHash = computeDiffHash(canonicalContent)
      const dedupMatch = await this.chunks.findByContentHash({
        memoryId: candidate.memoryId,
        projectKey: candidate.projectKey,
        workstreamKey: payload.workstreamKey,
        contentHash,
      })

      let newChunkId: string
      if (dedupMatch && dedupMatch.status !== 'active' && dedupMatch.status !== 'deleted') {
        await this.chunks.updateStatus(dedupMatch.id, { status: 'active', supersededBy: null })
        newChunkId = dedupMatch.id
      } else {
        const newChunk = await this.chunks.create({
          memoryId: candidate.memoryId,
          agentId: candidate.agentId,
          tenantId: candidate.tenantId,
          projectKey: candidate.projectKey,
          workstreamKey: payload.workstreamKey,
          type: payload.type!,
          path: payload.path!,
          title: payload.title!,
          text: payload.text!,
          summary: payload.summary,
          tags: payload.tags,
          salience: payload.salienceHint === 'high' ? 0.8 : 0.5,
          confidence: payload.confidence,
          sourceRefs: payload.sourceRefs,
          evidence: payload.evidence,
          approvedBy: actorId,
          approvedAt: now,
          reviewAfter: payload.reviewAfter ? new Date(payload.reviewAfter) : null,
          expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
          supersedes: payload.supersedes,
          contentHash,
        })
        newChunkId = newChunk.id
      }
      if (payload.supersedes && payload.supersedes !== newChunkId) {
        await this.chunks.updateStatus(payload.supersedes, { status: 'superseded', supersededBy: newChunkId })
      }
      resultChunkId = newChunkId
    }

    // §9.3/§10.1 (WP-8) — append-only manifest-pillanatkép CSAK tényleges
    // chunk-mutáció után. A tisztán advisory opok (`refresh_needed`/
    // `conflict_review`) nem billentenek chunk-státuszt → nem gyártunk no-op
    // manifest-sort, ami különben szennyezné a rollback idővonalát.
    if (!ADVISORY_ONLY_OPERATIONS.has(candidate.operation)) {
      await snapshotMemoryManifest({
        chunks: this.chunks,
        versions: this.versions,
        memoryId: candidate.memoryId,
        projectKey: candidate.projectKey,
        workstreamKey: payload.workstreamKey,
        changeSet: { operation: candidate.operation, candidateId: candidate.id, chunkId: resultChunkId },
        sourceCandidateIds: [candidate.id],
        approvedById: actorId,
      })
    }

    await this.candidates.updateStatus(candidate.id, {
      status: 'approved',
      approvedBy: actorId,
      approvedAt: now,
      writeGateTokenId: gateToken.id,
    })

    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'memory.candidate.approved',
      targetType: 'memory_candidate',
      targetId: candidate.id,
      modelUsed: null,
      inputRef: candidate.operation,
      outputRef: resultChunkId,
      policyDecision: 'write_gate_consumed',
      tenantId: candidate.tenantId,
      metadata: { candidateId: candidate.id, writeGateTokenId: gateToken.id, chunkId: resultChunkId },
    })
    if (!ADVISORY_ONLY_OPERATIONS.has(candidate.operation)) {
      await this.audit.append({
        actorType: 'human',
        actorId,
        agentVersion: null,
        action: CHUNK_AUDIT_ACTION_BY_OPERATION[candidate.operation] ?? 'memory.chunk.updated',
        targetType: 'memory_chunk',
        targetId: resultChunkId,
        modelUsed: null,
        inputRef: candidate.id,
        outputRef: resultChunkId,
        policyDecision: 'write_gate_consumed',
        tenantId: candidate.tenantId,
        metadata: { candidateId: candidate.id, operation: candidate.operation },
      })
    }

    return resultChunkId
  }

  /** S6: candidate és cél-agent csak az aktív tenantból kezelhető. */
  private async resolveCandidateForActor(
    candidateId: string,
    actor: MemoryApprovalActor,
    inputRef: string,
  ): Promise<
    | { ok: true; candidate: Awaited<ReturnType<MemoryCandidateRepository['findById']>> & {}; agent: NonNullable<Awaited<ReturnType<AgentRepository['findById']>>> }
    | { ok: false; result: MemoryApprovalResult }
  > {
    const candidate = await this.candidates.findById(candidateId)
    if (!candidate) return { ok: false, result: { ok: false, reason: 'candidate_not_found' } }

    const agent = await this.agents.findById(candidate.agentId)
    if (!agent) return { ok: false, result: { ok: false, reason: 'agent_not_found' } }

    if (candidate.tenantId !== actor.tenantId || !isAgentReachableFromTenant(agent.tenantId, actor.tenantId)) {
      await this.audit.append({
        actorType: 'human',
        actorId: actor.id,
        agentVersion: agent.currentVersion,
        action: 'user.authz.deny',
        targetType: 'memory_candidate',
        targetId: candidateId,
        modelUsed: null,
        inputRef,
        outputRef: null,
        policyDecision: 'tenant_mismatch',
        tenantId: candidate.tenantId,
        metadata: { candidateId, activeTenantId: actor.tenantId, agentId: agent.id },
      })
      return { ok: false, result: { ok: false, reason: 'tenant_mismatch' } }
    }

    return { ok: true, candidate, agent }
  }
}

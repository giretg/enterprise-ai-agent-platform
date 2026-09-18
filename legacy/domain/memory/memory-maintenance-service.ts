import type { MemoryChunk } from '@prisma/client'
import { estimateTextTokens } from '@/domain/conversation/context-assembly'
import { resolveSelfEvolutionProfile } from '@/lib/self-evolution-profile'
import type { AgentRepository, AuditRepository, MemoryCandidateRepository, MemoryChunkRepository } from '@/repositories/interfaces'
import { detectConflictsInPool } from './conflict-detection'
import { memoryCandidatesTotal } from '@/lib/observability/metrics'

/** §12.2 default — csak akkor él, ha a `self_evolution_profile.memory.maintenanceTokenBudget` nincs megadva. */
export const DEFAULT_MAINTENANCE_TOKEN_BUDGET = 4000
const MAINTENANCE_SCAN_LIMIT = 500
const ARCHIVE_SALIENCE_THRESHOLD = 0.15
const ARCHIVE_STALE_DAYS = 60

type MaintenanceOperation = 'refresh_needed' | 'archive' | 'demote' | 'conflict_review'

type MaintenanceProposal = {
  operation: MaintenanceOperation
  targetChunkId: string
  reason: string
}

export type MemoryMaintenanceRunResult = {
  proposedCandidateIds: string[]
  scannedChunkCount: number
  skippedByBudget: number
}

/**
 * agent-memory-persistent-cross-conversation-spec.md §8 (WP-8) —
 * `MemoryMaintenanceService`. Kemény szabály (§8.2): CSAK T1 `MemoryCandidate`
 * proposalokat gyárt, SOHA nem ír közvetlenül T2-be — a jóváhagyás a meglévő
 * `MemoryApprovalService.approve()` úton megy (proposedBy='maintenance_job').
 *
 * Determinisztikus, LLM-hívás NÉLKÜLI szabály-alapú generátor (§8.1 "dreaming"
 * itt nem modell-reflexió, hanem szabály-kiértékelés): `refresh_needed`
 * (lejárt `reviewAfter`), `archive` (alacsony salience + rég nem lekérdezett,
 * a `focus` kivétel — az mindig egyetlen, load-bearing aktív chunk),
 * `demote` (nettó negatív user-visszajelzés), `conflict_review` (WP-7
 * `detectConflictsInPool` high-risk találatai). A `merge`/`supersede`/
 * `delete_request` proposal-típusokat (§8.2) a v1 generátor TUDATOSAN nem
 * javasolja — tartalom-szintézist vagy visszavonhatatlan törlést igényelnének,
 * ami modell-döntést, nem szabály-kiértékelést kíván (dokumentált scope-döntés,
 * a §13 WP-3 demo-reseed halasztás mintáját követve).
 */
export class MemoryMaintenanceService {
  constructor(
    private readonly chunks: MemoryChunkRepository,
    private readonly candidates: MemoryCandidateRepository,
    private readonly audit: AuditRepository,
    private readonly agents?: AgentRepository,
  ) {}

  async run(params: {
    memoryId: string
    agentId: string
    tenantId: string | null
    projectKey: string
    workstreamKey?: string | null
    actorId: string
  }): Promise<MemoryMaintenanceRunResult> {
    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'memory.maintenance.started',
      targetType: 'memory',
      targetId: params.memoryId,
      modelUsed: null,
      inputRef: `project:${params.projectKey}`,
      outputRef: null,
      policyDecision: 'allowed',
      tenantId: params.tenantId,
      metadata: { agentId: params.agentId, memoryId: params.memoryId, projectKey: params.projectKey },
    })

    const tokenBudget = await this.resolveTokenBudget(params.agentId)
    const pool = await this.chunks.listRecentActive({
      memoryId: params.memoryId,
      projectKey: params.projectKey,
      workstreamKey: params.workstreamKey,
      limit: MAINTENANCE_SCAN_LIMIT,
    })

    const proposals = this.evaluate(pool)

    let usedTokens = 0
    let skippedByBudget = 0
    const proposedCandidateIds: string[] = []
    const now = new Date()

    for (const proposal of proposals) {
      const estTokens = estimateTextTokens(proposal.reason) + 24
      if (usedTokens + estTokens > tokenBudget) {
        skippedByBudget++
        continue
      }
      usedTokens += estTokens

      const candidate = await this.candidates.create({
        memoryId: params.memoryId,
        agentId: params.agentId,
        tenantId: params.tenantId,
        projectKey: params.projectKey,
        workstreamKey: params.workstreamKey ?? null,
        operation: proposal.operation,
        payload: {
          supersedes: proposal.targetChunkId,
          reason: proposal.reason,
        },
        status: 'proposed',
        proposedBy: 'maintenance_job',
        proposedByRunId: null,
        proposedInThreadId: null,
        ticketId: null,
        approvedBy: null,
        approvedAt: null,
        rejectedBy: null,
        rejectedAt: null,
        writeGateTokenId: null,
      })
      memoryCandidatesTotal.inc({ status: 'proposed' })
      proposedCandidateIds.push(candidate.id)

      await this.audit.append({
        actorType: 'human',
        actorId: params.actorId,
        agentVersion: null,
        action: 'memory.maintenance.proposed',
        targetType: 'memory_candidate',
        targetId: candidate.id,
        modelUsed: null,
        inputRef: proposal.targetChunkId,
        outputRef: `operation:${proposal.operation}`,
        policyDecision: 'allowed',
        tenantId: params.tenantId,
        metadata: {
          candidateId: candidate.id,
          operation: proposal.operation,
          targetChunkId: proposal.targetChunkId,
          reason: proposal.reason,
          generatedAt: now.toISOString(),
        },
      })
    }

    return { proposedCandidateIds, scannedChunkCount: pool.length, skippedByBudget }
  }

  private async resolveTokenBudget(agentId: string): Promise<number> {
    if (!this.agents) return DEFAULT_MAINTENANCE_TOKEN_BUDGET
    const agent = await this.agents.findById(agentId)
    if (!agent) return DEFAULT_MAINTENANCE_TOKEN_BUDGET
    const profile = resolveSelfEvolutionProfile(agent.selfEvolutionProfile)
    return profile.memory?.maintenanceTokenBudget ?? DEFAULT_MAINTENANCE_TOKEN_BUDGET
  }

  private evaluate(pool: MemoryChunk[]): MaintenanceProposal[] {
    const now = new Date()
    const proposals: MaintenanceProposal[] = []

    for (const chunk of pool) {
      if (chunk.reviewAfter && chunk.reviewAfter.getTime() < now.getTime()) {
        proposals.push({
          operation: 'refresh_needed',
          targetChunkId: chunk.id,
          reason: `"${chunk.title}" review-határideje lejárt (${chunk.reviewAfter.toISOString().slice(0, 10)})`,
        })
      }

      if (chunk.type !== 'focus' && chunk.salience < ARCHIVE_SALIENCE_THRESHOLD) {
        const staleSince = chunk.lastRetrievedAt ?? chunk.createdAt
        const staleDays = (now.getTime() - staleSince.getTime()) / (1000 * 60 * 60 * 24)
        if (staleDays >= ARCHIVE_STALE_DAYS) {
          proposals.push({
            operation: 'archive',
            targetChunkId: chunk.id,
            reason: `alacsony salience (${chunk.salience.toFixed(2)}) és ${Math.round(staleDays)} napja nem lekérdezett`,
          })
        }
      }

      if (chunk.userCorrectedCount > chunk.userConfirmedHelpfulCount) {
        proposals.push({
          operation: 'demote',
          targetChunkId: chunk.id,
          reason: `nettó negatív visszajelzés (correctedCount=${chunk.userCorrectedCount} > confirmedHelpfulCount=${chunk.userConfirmedHelpfulCount})`,
        })
      }
    }

    const conflictSets = detectConflictsInPool(
      pool.map((c) => ({
        id: c.id,
        type: c.type,
        path: c.path,
        tags: c.tags,
        status: c.status,
        supersedes: c.supersedes,
      })),
    )
    for (const set of conflictSets) {
      if (set.risk !== 'high') continue
      proposals.push({
        operation: 'conflict_review',
        targetChunkId: set.chunkIds[0],
        reason: `${set.reason} — érintett chunkok: ${set.chunkIds.join(', ')}`,
      })
    }

    return proposals
  }
}

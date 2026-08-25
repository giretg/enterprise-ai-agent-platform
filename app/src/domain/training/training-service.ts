import type { Ticket, UserRole } from '@prisma/client'
import { hasMinimumRole } from '@/lib/iam-policy'
import {
  requiresEvalGate,
  requiresHumanApproval,
  resolveSelfEvolutionProfile,
  type SelfEvolutionProfile,
} from '@/lib/self-evolution-profile'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'
import type { AgentRepository, AuditRepository, TicketRepository } from '@/repositories/interfaces'
import type { TicketService } from '../ticket/ticket-service'
import type { WriteGateService } from '../writegate/write-gate-service'
import type { EvalService } from '../eval/eval-service'
import type { SelfEvolutionGuard } from './self-evolution-guard'
import type { MemoryItemOperation } from './memory-items'
import {
  TrainingGateError,
  computeTrainingAllowedActions,
  fourEyesBlocksActor,
  hasTrainingActivationRight,
  hasTrainingProposeRight,
  hasTrainingRejectRight,
  nextStepLabel,
  resolveDurableMemoryApprovalPolicy,
  type TrainingActionErrorCode,
} from './durable-memory-policy'
import {
  TrainingCompositionError,
  buildImpactResult,
  composeProposedVersion,
  summarizeInstructionChange,
  type TrainingCompositionMode,
  type TrainingInstruction,
} from './training-composition'
import { signTrainingPreview, verifyTrainingPreview } from './training-preview-token'
import {
  type AgentTrainingContext,
  type RevisionRow,
  type TrainingStore,
} from './training-store'
import type { TrainingWorkspaceView } from './training-workspace-contract'

const NIL_VERSION_ID = '00000000-0000-4000-8000-000000000000'
const OPEN_TICKET_STATES = new Set(['backlog', 'ready', 'in_progress', 'awaiting_human', 'needs_info'])

export type TrainingActor = {
  id: string
  tenantId: string
  role: UserRole
}

function computeDiff(before: string, after: string) {
  return {
    summary: `Changed ${Math.abs(after.length - before.length)} chars`,
    before,
    after,
  }
}

function ticketPayloadKind(ticket: Ticket): string | undefined {
  if (typeof ticket.payload !== 'object' || ticket.payload === null || Array.isArray(ticket.payload)) {
    return undefined
  }
  const kind = (ticket.payload as Record<string, unknown>).kind
  return typeof kind === 'string' ? kind : undefined
}

export function isInstructionTrainingTicket(ticket: Pick<Ticket, 'type' | 'payload'>): boolean {
  if (ticket.type !== 'training') return false
  const kind = ticketPayloadKind(ticket as Ticket)
  return kind !== 'kb_document' && kind !== 'memory_candidate'
}

function writeGateBoundContent(params: {
  revisionId: string
  baseVersionId: string
  targetMemoryVersion: number
  proposedVersion: string
}): string {
  return JSON.stringify({
    revisionId: params.revisionId,
    baseVersionId: params.baseVersionId,
    targetMemoryVersion: params.targetMemoryVersion,
    proposedVersion: params.proposedVersion,
  })
}

function exceedsDiffLimit(profile: SelfEvolutionProfile, changeSummary: { added: string[]; removed: string[]; rewritten: unknown[] }): boolean {
  if (profile.diff_limit == null) return false
  const changed = changeSummary.added.length + changeSummary.removed.length + changeSummary.rewritten.length
  return changed > profile.diff_limit
}

export function mayOverrideFailedEval(profile: SelfEvolutionProfile): boolean {
  return !requiresEvalGate(profile)
}

export class TrainingService {
  constructor(
    private tickets: TicketRepository,
    private audit: AuditRepository,
    private ticketService: TicketService,
    private writeGate: WriteGateService,
    private evalService: EvalService,
    private agents: AgentRepository,
    private selfEvolutionGuard: SelfEvolutionGuard,
    private store: TrainingStore,
  ) {}

  private async requireReachableAgent(
    agentId: string,
    actor: TrainingActor,
    context: { ticketId?: string | null } = {},
  ): Promise<void> {
    const agent = await this.agents.findById(agentId)
    if (!agent || !isAgentReachableFromTenant(agent.tenantId, actor.tenantId)) {
      await this.auditTenantDenial(agentId, actor, context.ticketId ?? null)
      throw new Error('Agent not found')
    }
  }

  private async auditTenantDenial(agentId: string, actor: TrainingActor, ticketId: string | null) {
    await this.audit.append({
      actorType: 'human',
      actorId: actor.id,
      agentVersion: null,
      action: 'memory.write_denied',
      targetType: 'agent',
      targetId: agentId,
      modelUsed: null,
      inputRef: ticketId,
      outputRef: 'tenant_mismatch',
      policyDecision: 'tenant_mismatch',
      tenantId: actor.tenantId,
      metadata: { agentId, ticketId, activeTenantId: actor.tenantId },
    })
  }

  private assertTicketTenantScope(ticket: Pick<Ticket, 'tenantId'>, actor: TrainingActor) {
    if (ticket.tenantId !== null && ticket.tenantId !== actor.tenantId) {
      throw new Error('Training ticket not found')
    }
  }

  private async writeDenied(params: {
    actor: TrainingActor
    agent: Pick<AgentTrainingContext, 'id' | 'currentVersion' | 'memoryId' | 'tenantId'>
    ticketId?: string | null
    reason: string
    metadata?: Record<string, unknown>
  }) {
    await this.audit.append({
      actorType: 'human',
      actorId: params.actor.id,
      agentVersion: params.agent.currentVersion,
      action: 'memory.write_denied',
      targetType: 'memory',
      targetId: params.agent.memoryId,
      modelUsed: null,
      inputRef: params.ticketId ?? null,
      outputRef: params.reason,
      policyDecision: params.reason,
      tenantId: params.agent.tenantId,
      metadata: { agentId: params.agent.id, ...(params.metadata ?? {}) },
    })
  }

  private async loadContext(agentId: string, actor: TrainingActor): Promise<AgentTrainingContext> {
    await this.requireReachableAgent(agentId, actor)
    const ctx = await this.store.findAgentContext(agentId)
    if (!ctx) throw new Error('Agent not found')
    return ctx
  }

  private async findOpenInstructionTicket(agentId: string): Promise<Ticket | null> {
    const rows = await this.tickets.findMany({ agentId, type: 'training' })
    return (
      rows.find(
        (ticket) =>
          isInstructionTrainingTicket(ticket) && OPEN_TICKET_STATES.has(ticket.state),
      ) ?? null
    )
  }

  /** N6 / §4.6: önfejlesztési útvonal soha nem bővíthet capability-t. */
  async attemptCapabilityEscalation(params: {
    agentId: string
    toolName: string
    ticketId?: string | null
    connectorId?: string | null
  }) {
    return this.selfEvolutionGuard.denyCapabilityEscalation({
      agentId: params.agentId,
      toolName: params.toolName,
      actorType: 'agent',
      actorId: params.agentId,
      ticketId: params.ticketId ?? null,
      connectorId: params.connectorId ?? null,
    })
  }

  async promoteMemoryWithoutHumanApproval(ticketId: string, actor: TrainingActor) {
    const ticket = await this.tickets.findById(ticketId)
    if (!ticket || ticket.type !== 'training') throw new Error('Training ticket not found')
    this.assertTicketTenantScope(ticket, actor)
    if (!ticket.agentId) throw new Error('Training ticket has no agent')
    await this.requireReachableAgent(ticket.agentId, actor, { ticketId })

    const ctx = await this.store.findAgentContext(ticket.agentId)
    if (!ctx) throw new Error('Agent not found')

    const profile = resolveSelfEvolutionProfile(ctx.selfEvolutionProfile)
    if (requiresHumanApproval(profile)) {
      throw new Error('human_approval_required')
    }

    throw new Error('auto_promote_not_implemented_for_profile')
  }

  async getTrainingWorkspace(params: { agentId: string; actor: TrainingActor }): Promise<TrainingWorkspaceView> {
    const ctx = await this.loadContext(params.agentId, params.actor)
    const profile = resolveSelfEvolutionProfile(ctx.selfEvolutionProfile)
    const policy = resolveDurableMemoryApprovalPolicy(profile)
    const pendingTicket = await this.findOpenInstructionTicket(ctx.id)
    let pendingRevision: RevisionRow | null = null
    if (pendingTicket) {
      const meta = await this.store.findTrainingMeta(pendingTicket.id)
      if (meta?.currentRevisionId) {
        pendingRevision = await this.store.findRevision(meta.currentRevisionId)
      }
    }

    const pending = pendingRevision
      ? { createdById: pendingRevision.createdById }
      : pendingTicket
        ? { createdById: pendingTicket.createdById }
        : null

    const allowedActions = computeTrainingAllowedActions({
      role: params.actor.role,
      policy,
      actorId: params.actor.id,
      pending,
    })
    const fourEyesWaiting = Boolean(
      pending &&
        fourEyesBlocksActor({
          policy,
          actorId: params.actor.id,
          revisionCreatedById: pending.createdById,
        }) &&
        hasTrainingActivationRight(params.actor.role, policy),
    )

    const timeline = (await this.store.listInstructionVersions(ctx.memoryId, 20)).map((row) => ({
      id: row.id,
      version: row.version,
      status: row.status,
      source: row.source,
      approvedBy: row.approvedById,
      createdAt: row.createdAt,
      content: row.content,
    }))

    return {
      agentId: ctx.id,
      agentName: ctx.name,
      activeVersion: ctx.currentInstruction
        ? {
            id: ctx.currentInstruction.id,
            version: ctx.currentInstruction.version,
            content: ctx.currentInstruction.content ?? '',
            createdAt: ctx.currentInstruction.createdAt,
            source: ctx.currentInstruction.source,
          }
        : null,
      pendingProposal: pendingRevision && pendingTicket
        ? {
            ticketId: pendingTicket.id,
            revisionId: pendingRevision.id,
            revision: pendingRevision.revision,
            proposedVersion: pendingRevision.proposedVersionRef,
            changeSummary: pendingRevision.changeSummary,
            impactResult: pendingRevision.impactResult,
            createdById: pendingRevision.createdById,
            targetMemoryVersion: pendingRevision.targetMemoryVersion,
            fourEyesWaiting,
            nextStep: nextStepLabel({
              allowedActions,
              pending: true,
              fourEyesWaiting,
            }),
          }
        : null,
      allowedActions,
      timeline,
      policy,
    }
  }

  async previewTrainingChange(params: {
    agentId: string
    instruction: TrainingInstruction
    compositionMode?: TrainingCompositionMode | null
    actor: TrainingActor
  }) {
    const ctx = await this.loadContext(params.agentId, params.actor)
    if (!hasTrainingProposeRight(params.actor.role)) {
      throw new TrainingGateError('activation_forbidden', 'Nincs jogod tanítási javaslatot készíteni')
    }
    const profile = resolveSelfEvolutionProfile(ctx.selfEvolutionProfile)
    if (!profile.scope.includes('memory')) {
      throw new TrainingGateError('scope_exceeded')
    }

    const pendingTicket = await this.findOpenInstructionTicket(ctx.id)
    let pendingContent: string | null = null
    if (pendingTicket) {
      const meta = await this.store.findTrainingMeta(pendingTicket.id)
      const revision = meta?.currentRevisionId ? await this.store.findRevision(meta.currentRevisionId) : null
      pendingContent = revision?.proposedVersionRef ?? null
      if (!params.compositionMode) {
        throw new TrainingGateError('composition_required')
      }
      if (params.compositionMode === 'replace_pending') {
        const own = (revision?.createdById ?? pendingTicket.createdById) === params.actor.id
        if (!own && !hasTrainingRejectRight(params.actor.role)) {
          throw new TrainingGateError('replace_not_allowed')
        }
      }
    }

    try {
      const composed = composeProposedVersion({
        activeContent: ctx.currentInstruction?.content ?? '',
        pendingContent,
        instruction: params.instruction,
        compositionMode: params.compositionMode ?? null,
      })
      const changeSummary = summarizeInstructionChange(
        composed.base === 'pending' ? (pendingContent ?? '') : (ctx.currentInstruction?.content ?? ''),
        composed.proposedVersion,
      )
      const impactResult = buildImpactResult({ changeSummary, proposedVersion: composed.proposedVersion })
      const previewId = signTrainingPreview({
        agentId: ctx.id,
        actorId: params.actor.id,
        tenantId: params.actor.tenantId,
        baseVersionId: ctx.currentInstruction?.id ?? NIL_VERSION_ID,
        proposedVersion: composed.proposedVersion,
        compositionMode: composed.compositionMode,
        instruction: params.instruction,
        changeSummary,
        impactResult,
      })
      return {
        previewId,
        baseVersionId: ctx.currentInstruction?.id ?? NIL_VERSION_ID,
        proposedVersion: composed.proposedVersion,
        changeSummary,
        impactResult,
      }
    } catch (e) {
      if (e instanceof TrainingCompositionError) {
        throw new TrainingGateError(e.code)
      }
      throw e
    }
  }

  async submitTrainingProposal(params: { previewId: string; actor: TrainingActor }) {
    const preview = verifyTrainingPreview(params.previewId)
    if (preview.actorId !== params.actor.id || preview.tenantId !== params.actor.tenantId) {
      throw new TrainingGateError('stale_revision')
    }
    const ctx = await this.loadContext(preview.agentId, params.actor)
    if (!hasTrainingProposeRight(params.actor.role)) {
      throw new TrainingGateError('activation_forbidden', 'Nincs jogod tanítási javaslatot készíteni')
    }
    if (preview.impactResult.verdict === 'blocked') {
      await this.writeDenied({
        actor: params.actor,
        agent: ctx,
        reason: 'hard_floor',
        metadata: { matched: preview.impactResult.hardFloor.blocked ? preview.impactResult.hardFloor.matched : null },
      })
      throw new TrainingGateError('hard_floor')
    }

    const currentId = ctx.currentInstruction?.id ?? NIL_VERSION_ID
    if (preview.baseVersionId !== currentId) {
      throw new TrainingGateError('base_version_stale')
    }

    const profile = resolveSelfEvolutionProfile(ctx.selfEvolutionProfile)
    if (!profile.scope.includes('memory')) {
      throw new TrainingGateError('scope_exceeded')
    }
    if (exceedsDiffLimit(profile, preview.changeSummary)) {
      throw new TrainingGateError('diff_limit_exceeded')
    }

    const pendingTicket = await this.findOpenInstructionTicket(ctx.id)
    const source =
      preview.instruction.kind === 'item_change'
        ? `item_${preview.instruction.change.operation}`
        : preview.instruction.kind === 'teach'
          ? 'teach'
          : 'training'

    if (pendingTicket && preview.compositionMode === 'replace_pending') {
      const meta = await this.store.findTrainingMeta(pendingTicket.id)
      const currentRev = meta?.currentRevisionId ? await this.store.findRevision(meta.currentRevisionId) : null
      const own = (currentRev?.createdById ?? pendingTicket.createdById) === params.actor.id
      if (!own && !hasTrainingRejectRight(params.actor.role)) {
        throw new TrainingGateError('replace_not_allowed')
      }
    }

    const diff = computeDiff(
      preview.compositionMode === 'build_on_pending'
        ? ((await this.currentPendingContent(pendingTicket)) ?? ctx.currentInstruction?.content ?? '')
        : (ctx.currentInstruction?.content ?? ''),
      preview.proposedVersion,
    )

    let ticket = pendingTicket
    if (!ticket) {
      try {
        ticket = await this.tickets.create({
          tenantId: ctx.tenantId ?? params.actor.tenantId,
          type: 'training',
          title: `Tanítás: ${ctx.name}`,
          state: 'backlog',
          assigneeType: 'human',
          assigneeId: null,
          agentId: ctx.id,
          payload: {
            diff,
            proposedContent: preview.proposedVersion,
            source,
          },
          sourceDocumentId: null,
          executeAfter: null,
          dueBy: null,
          createdById: params.actor.id,
        })
      } catch (error) {
        // Az adatbázis részleges unique indexe nyeri meg a párhuzamos submit-versenyt.
        // A vesztes kliensnek újra meg kell néznie a közben létrejött javaslatot.
        if (await this.findOpenInstructionTicket(ctx.id)) {
          throw new TrainingGateError('composition_required')
        }
        throw error
      }
      const targetMemoryVersion = await this.store.nextInstructionVersion(ctx.memoryId)
      await this.store.createTrainingMeta({
        ticketId: ticket.id,
        proposedDiff: diff,
        targetMemoryVersion,
        // Ez az útvonal user-kezdeményezett. Az általános approval_mode csak a
        // későbbi reflection/system eredetű önfejlesztést kapuzhatja.
        evalRequired: false,
        origin: 'human',
        scopeClass: 'memory',
      })
      await this.ticketService.transition({ ticketId: ticket.id, toState: 'ready', actor: { type: 'system' } })
      await this.ticketService.transition({ ticketId: ticket.id, toState: 'in_progress', actor: { type: 'system' } })
      ticket = await this.ticketService.transition({
        ticketId: ticket.id,
        toState: 'awaiting_human',
        actor: { type: 'system' },
      })
    }

    const meta = await this.store.findTrainingMeta(ticket.id)
    if (!meta) throw new Error('Training ticket not found')
    const existing = await this.store.listRevisions(ticket.id)
    const nextRevision = (existing.at(-1)?.revision ?? 0) + 1
    await this.store.supersedeCurrentRevisions(ticket.id)
    const revision = await this.store.createRevision({
      trainingTicketId: ticket.id,
      revision: nextRevision,
      baseVersionId: preview.baseVersionId,
      proposedVersionRef: preview.proposedVersion,
      changeSummary: preview.changeSummary,
      impactResult: preview.impactResult,
      compositionMode: preview.compositionMode ?? 'replace_pending',
      targetMemoryVersion: meta.targetMemoryVersion,
      createdById: params.actor.id,
    })
    await this.store.updateTrainingMeta(ticket.id, {
      currentRevisionId: revision.id,
      proposedDiff: diff,
    })
    await this.tickets.update(ticket.id, {
      payload: {
        diff,
        proposedContent: preview.proposedVersion,
        source,
        currentRevisionId: revision.id,
      },
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.actor.id,
      agentVersion: ctx.currentVersion,
      action: 'training.proposed',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: String(ctx.currentInstruction?.version ?? 0),
      outputRef: String(meta.targetMemoryVersion),
      policyDecision: preview.compositionMode ?? 'new',
      tenantId: ctx.tenantId,
      ticketId: ticket.id,
      metadata: { revisionId: revision.id, revision: revision.revision },
    })

    return { ticket, currentRevision: revision }
  }

  private async currentPendingContent(ticket: Ticket | null): Promise<string | null> {
    if (!ticket) return null
    const meta = await this.store.findTrainingMeta(ticket.id)
    if (!meta?.currentRevisionId) return null
    const revision = await this.store.findRevision(meta.currentRevisionId)
    return revision?.proposedVersionRef ?? null
  }

  async activateTraining(params: {
    ticketId: string
    revisionId: string
    actor: TrainingActor
    overrideEval?: boolean
  }) {
    const ticket = await this.tickets.findById(params.ticketId)
    if (!ticket || ticket.type !== 'training') throw new Error('Training ticket not found')
    this.assertTicketTenantScope(ticket, params.actor)
    if (!ticket.agentId) throw new Error('Training ticket has no agent')
    await this.requireReachableAgent(ticket.agentId, params.actor, { ticketId: params.ticketId })
    if (ticketPayloadKind(ticket) === 'kb_document') {
      throw new Error('Use the knowledge base approval flow for KB document tickets')
    }

    const ctx = await this.store.findAgentContext(ticket.agentId)
    if (!ctx) throw new Error('Agent not found')
    const profile = resolveSelfEvolutionProfile(ctx.selfEvolutionProfile)
    const policy = resolveDurableMemoryApprovalPolicy(profile)

    const deny = async (code: TrainingActionErrorCode, extra?: Record<string, unknown>): Promise<never> => {
      await this.writeDenied({
        actor: params.actor,
        agent: ctx,
        ticketId: params.ticketId,
        reason: code,
        metadata: extra,
      })
      throw new TrainingGateError(code)
    }

    if (!hasTrainingActivationRight(params.actor.role, policy)) {
      return await deny('activation_forbidden')
    }

    const revision = await this.store.findRevision(params.revisionId)
    if (!revision || revision.trainingTicketId !== params.ticketId) {
      return await deny('stale_revision')
    }
    const currentMeta = await this.store.findTrainingMeta(params.ticketId)
    if (!currentMeta || currentMeta.currentRevisionId !== revision.id || revision.status !== 'current') {
      return await deny('stale_revision')
    }

    if (
      fourEyesBlocksActor({
        policy,
        actorId: params.actor.id,
        revisionCreatedById: revision.createdById,
      })
    ) {
      return await deny('four_eyes_required')
    }

    const currentId = ctx.currentInstruction?.id ?? NIL_VERSION_ID
    if (revision.baseVersionId !== currentId) {
      return await deny('base_version_stale')
    }

    if (!profile.scope.includes('memory')) {
      return await deny('scope_exceeded')
    }

    const changeSummary = summarizeInstructionChange(
      ctx.currentInstruction?.content ?? '',
      revision.proposedVersionRef,
    )
    if (exceedsDiffLimit(profile, changeSummary)) {
      return await deny('diff_limit_exceeded')
    }

    const impact = buildImpactResult({
      changeSummary,
      proposedVersion: revision.proposedVersionRef,
    })
    if (impact.verdict === 'blocked') {
      return await deny('hard_floor', { matched: impact.hardFloor.blocked ? impact.hardFloor.matched : null })
    }

    const approver = await this.store.findUser(params.actor.id)
    if (!approver) throw new Error('Approver not found')

    let evalRun = null
    const evalRequired = currentMeta.origin !== 'human' && currentMeta.evalRequired
    if (evalRequired) {
      const activeEval = await this.evalService.findActiveForAgent(ctx.id)
      if (!activeEval) {
        throw new Error('eval_required_but_missing')
      }
      evalRun = await this.evalService.run({
        evalId: activeEval.id,
        agentId: ctx.id,
        proposedContent: revision.proposedVersionRef,
        agentVersion: ctx.currentVersion,
        trigger: 'pre_training_approval',
      })
      await this.store.updateTrainingMeta(params.ticketId, {
        evalResult: evalRun.details ?? { passed: evalRun.passed, score: evalRun.score },
      })
      if (!evalRun.passed && (!params.overrideEval || !mayOverrideFailedEval(profile))) {
        await this.audit.append({
          actorType: 'human',
          actorId: params.actor.id,
          agentVersion: ctx.currentVersion,
          action: 'memory.write.eval_blocked',
          targetType: 'memory',
          targetId: ctx.memoryId,
          modelUsed: null,
          inputRef: activeEval.id,
          outputRef: evalRun.id,
          policyDecision: mayOverrideFailedEval(profile)
            ? `eval_failed:score=${evalRun.score.toFixed(2)}`
            : `eval_required_failed:score=${evalRun.score.toFixed(2)}`,
          tenantId: ctx.tenantId,
          metadata: { eval: evalRun.details, overrideRequested: params.overrideEval ?? false },
        })
        if (!mayOverrideFailedEval(profile)) {
          await this.ticketService.transition({
            ticketId: params.ticketId,
            toState: 'rejected',
            actor: { type: 'system' },
            note: `eval_required_failed: score ${Math.round(evalRun.score * 100)}%`,
            agentVersion: ctx.currentVersion,
          })
        }
        throw new TrainingGateError(
          'eval_failed',
          mayOverrideFailedEval(profile)
            ? `eval_failed: score ${Math.round(evalRun.score * 100)}% — use overrideEval to proceed`
            : `eval_failed: score ${Math.round(evalRun.score * 100)}% — required eval cannot be overridden`,
        )
      }
    }

    const boundContent = writeGateBoundContent({
      revisionId: revision.id,
      baseVersionId: revision.baseVersionId,
      targetMemoryVersion: revision.targetMemoryVersion,
      proposedVersion: revision.proposedVersionRef,
    })
    const gateContext = {
      tenantId: ctx.tenantId,
      actorType: 'human' as const,
      actorId: params.actor.id,
      agentVersion: ctx.currentVersion,
    }
    const gateToken = await this.writeGate.issue({
      trainingTicketId: params.ticketId,
      agentId: ctx.id,
      targetMemoryId: ctx.memoryId,
      proposedContent: boundContent,
      context: gateContext,
    })
    await this.writeGate.consume({
      tokenId: gateToken.id,
      actualProposedContent: boundContent,
      context: gateContext,
    })

    await this.store.updateRevision(revision.id, {
      tokenStatus: 'consumed',
      writeGateTokenRef: gateToken.id,
    })
    await this.store.updateTrainingMeta(params.ticketId, { writeGateTokenRef: gateToken.id })

    const nextVersion = revision.targetMemoryVersion
    const memoryVersion = await this.store.activateInstructionVersion({
      memoryId: ctx.memoryId,
      version: nextVersion,
      content: revision.proposedVersionRef,
      diffFromPrevious: computeDiff(ctx.currentInstruction?.content ?? '', revision.proposedVersionRef),
      source: 'training',
      approvedById: params.actor.id,
      parentVersion: ctx.currentInstruction?.version ?? null,
      expectedCurrentVersionId: ctx.currentInstruction?.id ?? null,
    })
    if (!memoryVersion) return await deny('base_version_stale')

    if (ticket.state === 'awaiting_human') {
      // Az awaiting_human → approved ticket-szabály approver szerepet vár.
      // `operator_can_activate` esetén a policy már engedélyezte a hívót; a
      // ticket-gép system-átmenettel lép, a döntéshozó az auditban marad.
      await this.ticketService.transition({
        ticketId: params.ticketId,
        toState: 'approved',
        actor: hasMinimumRole(params.actor.role, 'approver')
          ? { type: 'human', userId: params.actor.id, role: params.actor.role }
          : { type: 'system' },
        note: hasMinimumRole(params.actor.role, 'approver') ? undefined : 'operator_can_activate',
        agentVersion: ctx.currentVersion,
      })
    }
    if (ticket.state !== 'done') {
      await this.ticketService.transition({
        ticketId: params.ticketId,
        toState: 'done',
        actor: { type: 'system' },
      })
    }

    await this.audit.append({
      actorType: 'human',
      actorId: params.actor.id,
      agentVersion: ctx.currentVersion,
      action: 'training.approved',
      targetType: 'ticket',
      targetId: params.ticketId,
      modelUsed: null,
      inputRef: revision.id,
      outputRef: String(nextVersion),
      policyDecision: 'activated',
      tenantId: ctx.tenantId,
      ticketId: params.ticketId,
      metadata: {
        revisionId: revision.id,
        revisionCreatedBy: revision.createdById,
        writeGateTokenId: gateToken.id,
      },
    })
    await this.audit.append({
      actorType: 'human',
      actorId: params.actor.id,
      agentVersion: ctx.currentVersion,
      action: 'memory.update',
      targetType: 'memory',
      targetId: ctx.memoryId,
      modelUsed: null,
      inputRef: String(ctx.currentInstruction?.version ?? 0),
      outputRef: String(nextVersion),
      policyDecision: evalRun?.passed === false ? 'write_gate_consumed:eval_override' : 'write_gate_consumed',
      tenantId: ctx.tenantId,
      metadata: { writeGateTokenId: gateToken.id, evalRunId: evalRun?.id ?? null, kind: 'instruction' },
    })

    return { memoryVersion, writeGateTokenId: gateToken.id, evalRun }
  }

  async rejectTraining(params: { ticketId: string; reason: string; actor: TrainingActor }) {
    const ticket = await this.tickets.findById(params.ticketId)
    if (!ticket || ticket.type !== 'training') throw new Error('Training ticket not found')
    this.assertTicketTenantScope(ticket, params.actor)
    if (!ticket.agentId) throw new Error('Training ticket has no agent')
    await this.requireReachableAgent(ticket.agentId, params.actor, { ticketId: params.ticketId })
    if (!hasTrainingRejectRight(params.actor.role)) {
      throw new TrainingGateError('activation_forbidden')
    }
    const ctx = await this.store.findAgentContext(ticket.agentId)
    if (!ctx) throw new Error('Agent not found')
    const meta = await this.store.findTrainingMeta(params.ticketId)
    if (meta?.currentRevisionId) {
      await this.store.updateRevision(meta.currentRevisionId, { tokenStatus: 'revoked', status: 'superseded' })
    }
    await this.ticketService.transition({
      ticketId: params.ticketId,
      toState: 'rejected',
      actor: { type: 'human', userId: params.actor.id, role: params.actor.role },
      note: params.reason,
      agentVersion: ctx.currentVersion,
    })
    await this.audit.append({
      actorType: 'human',
      actorId: params.actor.id,
      agentVersion: ctx.currentVersion,
      action: 'training.rejected',
      targetType: 'ticket',
      targetId: params.ticketId,
      modelUsed: null,
      inputRef: params.reason,
      outputRef: 'rejected',
      policyDecision: 'rejected',
      tenantId: ctx.tenantId,
      ticketId: params.ticketId,
      metadata: { reason: params.reason },
    })
  }

  async createTrainingTicket(params: {
    agentId: string
    proposedContent: string
    source: string
    actor: TrainingActor
  }) {
    const pending = await this.findOpenInstructionTicketAfterReachable(params.agentId, params.actor)
    const preview = await this.previewTrainingChange({
      agentId: params.agentId,
      instruction: { kind: 'full_version', content: params.proposedContent },
      compositionMode: pending ? 'replace_pending' : null,
      actor: params.actor,
    })
    const submitted = await this.submitTrainingProposal({ previewId: preview.previewId, actor: params.actor })
    return submitted.ticket
  }

  private async findOpenInstructionTicketAfterReachable(agentId: string, actor: TrainingActor) {
    await this.requireReachableAgent(agentId, actor)
    return this.findOpenInstructionTicket(agentId)
  }

  /** N7 / §5.13.2: ticket nélküli beszélgetésből sem írhat memóriát write-gate nélkül. */
  async attemptUngatedMemoryWrite(params: {
    agentId: string
    proposedContent: string
    conversationId?: string | null
  }) {
    await this.audit.append({
      actorType: 'agent',
      actorId: params.agentId,
      agentVersion: null,
      action: 'memory.write_denied',
      targetType: params.conversationId ? 'conversation' : 'agent',
      targetId: params.conversationId ?? params.agentId,
      modelUsed: null,
      inputRef: 'ungated_memory_write',
      outputRef: 'write_gate_required',
      policyDecision: 'write_gate_required',
      metadata: {
        conversationId: params.conversationId ?? null,
        contentLength: params.proposedContent.length,
      },
    })

    return { allowed: false as const, reason: 'write_gate_required' }
  }

  async approveTraining(
    ticketId: string,
    actor: TrainingActor,
    opts: { overrideEval?: boolean } = {},
  ) {
    const ticket = await this.tickets.findById(ticketId)
    if (!ticket || ticket.type !== 'training') throw new Error('Training ticket not found')
    this.assertTicketTenantScope(ticket, actor)
    if (!ticket.agentId) throw new Error('Training ticket has no agent')
    await this.requireReachableAgent(ticket.agentId, actor, { ticketId })
    if (ticket.state !== 'awaiting_human') throw new Error('Ticket not awaiting approval')
    if (ticketPayloadKind(ticket) === 'kb_document') {
      throw new Error('Use the knowledge base approval flow for KB document tickets')
    }

    const meta = await this.store.findTrainingMeta(ticketId)
    let revisionId = meta?.currentRevisionId
    if (!revisionId) {
      revisionId = (await this.ensureLegacyRevision(ticket, ticket.agentId)).id
    }

    return this.activateTraining({
      ticketId,
      revisionId,
      actor,
      overrideEval: opts.overrideEval,
    })
  }

  async proposeMemoryItemChange(params: {
    agentId: string
    change: MemoryItemOperation
    actor: TrainingActor
  }) {
    const pending = await this.findOpenInstructionTicketAfterReachable(params.agentId, params.actor)
    const preview = await this.previewTrainingChange({
      agentId: params.agentId,
      instruction: { kind: 'item_change', change: params.change },
      compositionMode: pending ? 'build_on_pending' : null,
      actor: params.actor,
    })
    if (preview.impactResult.verdict === 'blocked') {
      throw new TrainingGateError('hard_floor')
    }
    const submitted = await this.submitTrainingProposal({ previewId: preview.previewId, actor: params.actor })
    return submitted.ticket
  }

  async listMemoryVersionsForTraining(agentId: string, actor: TrainingActor, limit = 20) {
    const ctx = await this.loadContext(agentId, actor)
    const versions = await this.store.listInstructionVersions(ctx.memoryId, limit)
    return {
      currentVersionId: ctx.currentInstruction?.id ?? null,
      versions,
    }
  }

  async rollbackMemory(agentId: string, toVersion: number, actor: TrainingActor) {
    const actorId = actor.id
    await this.requireReachableAgent(agentId, actor)
    if (!hasMinimumRole(actor.role, 'approver')) {
      throw new TrainingGateError('activation_forbidden')
    }

    const ctx = await this.store.findAgentContext(agentId)
    if (!ctx) throw new Error('Agent not found')

    const target = await this.store.findInstructionVersion(ctx.memoryId, toVersion)
    if (!target) throw new Error('Memory version not found')

    const restored = await this.store.restoreInstructionVersion({
      memoryId: ctx.memoryId,
      targetId: target.id,
      expectedCurrentVersionId: ctx.currentInstruction?.id ?? null,
    })
    if (!restored) throw new TrainingGateError('base_version_stale')

    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: ctx.currentVersion,
      action: 'memory.rollback',
      targetType: 'memory',
      targetId: ctx.memoryId,
      modelUsed: null,
      inputRef: ctx.currentInstruction ? String(ctx.currentInstruction.version) : null,
      outputRef: String(toVersion),
      policyDecision: 'rollback',
      tenantId: ctx.tenantId,
      metadata: { kind: 'instruction' },
    })

    return target
  }

  private async ensureLegacyRevision(ticket: Ticket, agentId: string) {
    const payload = ticket.payload as { proposedContent?: string; source?: string }
    if (!payload.proposedContent) throw new Error('Training ticket has no proposed content')
    const ctx = await this.store.findAgentContext(agentId)
    if (!ctx) throw new Error('Agent not found')
    let meta = await this.store.findTrainingMeta(ticket.id)
    if (!meta) {
      const targetMemoryVersion = await this.store.nextInstructionVersion(ctx.memoryId)
      await this.store.createTrainingMeta({
        ticketId: ticket.id,
        proposedDiff: computeDiff(ctx.currentInstruction?.content ?? '', payload.proposedContent),
        targetMemoryVersion,
        evalRequired: false,
        origin: 'human',
        scopeClass: 'memory',
      })
      meta = await this.store.findTrainingMeta(ticket.id)
    }
    if (!meta) throw new Error('Training ticket not found')
    const revision = await this.store.createRevision({
      trainingTicketId: ticket.id,
      revision: 1,
      baseVersionId: ctx.currentInstruction?.id ?? NIL_VERSION_ID,
      proposedVersionRef: payload.proposedContent,
      changeSummary: summarizeInstructionChange(ctx.currentInstruction?.content ?? '', payload.proposedContent),
      impactResult: buildImpactResult({
        changeSummary: summarizeInstructionChange(ctx.currentInstruction?.content ?? '', payload.proposedContent),
        proposedVersion: payload.proposedContent,
      }),
      compositionMode: 'replace_pending',
      targetMemoryVersion: meta.targetMemoryVersion,
      createdById: ticket.createdById,
    })
    await this.store.updateTrainingMeta(ticket.id, { currentRevisionId: revision.id })
    return revision
  }
}

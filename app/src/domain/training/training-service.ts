import { prisma } from '@/lib/db'
import {
  requiresEvalGate,
  requiresHumanApproval,
  resolveSelfEvolutionProfile,
} from '@/lib/self-evolution-profile'
import type { AgentRepository, AuditRepository, TicketRepository } from '@/repositories/interfaces'
import type { TicketService } from '../ticket/ticket-service'
import type { WriteGateService } from '../writegate/write-gate-service'
import type { EvalService } from '../eval/eval-service'
import type { SelfEvolutionGuard } from './self-evolution-guard'

function computeDiff(before: string, after: string) {
  return {
    summary: `Changed ${Math.abs(after.length - before.length)} chars`,
    before,
    after,
  }
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
  ) {}

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

  async promoteMemoryWithoutHumanApproval(ticketId: string) {
    const ticket = await this.tickets.findById(ticketId)
    if (!ticket || ticket.type !== 'training') throw new Error('Training ticket not found')
    if (!ticket.agentId) throw new Error('Training ticket has no agent')

    const agent = await prisma.agent.findUnique({ where: { id: ticket.agentId } })
    if (!agent) throw new Error('Agent not found')

    const profile = resolveSelfEvolutionProfile(agent.selfEvolutionProfile)
    if (requiresHumanApproval(profile)) {
      throw new Error('human_approval_required')
    }

    throw new Error('auto_promote_not_implemented_for_profile')
  }

  async createTrainingTicket(params: {
    agentId: string
    proposedContent: string
    source: string
    createdById: string
  }) {
    const agent = await prisma.agent.findUnique({
      where: { id: params.agentId },
      include: { memory: { include: { currentVersion: true } } },
    })
    if (!agent) throw new Error('Agent not found')

    const profile = resolveSelfEvolutionProfile(agent.selfEvolutionProfile)
    if (!profile.scope.includes('memory')) {
      throw new Error('self_evolution_scope_excludes_memory')
    }

    const currentContent = agent.memory.currentVersion?.content ?? ''
    const diff = computeDiff(currentContent, params.proposedContent)

    // §4.4: a write-gate token a következő (cél) memória-verzióra köt majd.
    const maxVersionRow = await prisma.memoryVersion.aggregate({
      where: { memoryId: agent.memoryId },
      _max: { version: true },
    })
    const targetMemoryVersion = (maxVersionRow._max.version ?? 0) + 1

    const ticket = await this.tickets.create({
      type: 'training',
      title: `Tanítás: ${agent.name}`,
      state: 'backlog',
      assigneeType: 'human',
      assigneeId: null,
      agentId: params.agentId,
      payload: { diff, proposedContent: params.proposedContent, source: params.source },
      sourceDocumentId: null,
      executeAfter: null,
      dueBy: null,
      createdById: params.createdById,
    })

    // §4.4: first-class training_tickets sor — a proposed diff és a cél-verzió
    // a ticket payloadtól függetlenül, lekérdezhető formában.
    await prisma.trainingTicket.create({
      data: {
        ticketId: ticket.id,
        proposedDiff: diff,
        targetMemoryVersion,
        writeGateTokenRef: null,
        evalResult: undefined,
      },
    })

    // Az állapotgépen át vezetjük a jóváhagyási kapuig — minden lépés auditált (4.1).
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
    return this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'awaiting_human',
      actor: { type: 'system' },
    })
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
    approverId: string,
    opts: { overrideEval?: boolean } = {},
  ) {
    const ticket = await this.tickets.findById(ticketId)
    if (!ticket || ticket.type !== 'training') throw new Error('Training ticket not found')
    if (ticket.state !== 'awaiting_human') throw new Error('Ticket not awaiting approval')

    // KB-dokumentum tanítási ticket: külön útvonalon (KnowledgeBaseService) megy,
    // nem a memória-write-gate-en — ne kezeljük memória-jóváhagyásként.
    const payloadKind =
      typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
        ? (ticket.payload as Record<string, unknown>).kind
        : undefined
    if (payloadKind === 'kb_document') {
      throw new Error('Use the knowledge base approval flow for KB document tickets')
    }

    const approver = await prisma.user.findUnique({ where: { id: approverId } })
    if (!approver) throw new Error('Approver not found')

    const payload = ticket.payload as { proposedContent: string; source?: string }

    const agent = await prisma.agent.findUnique({
      where: { id: ticket.agentId! },
      include: { memory: { include: { currentVersion: true } } },
    })
    if (!agent) throw new Error('Agent not found')

    const profile = resolveSelfEvolutionProfile(agent.selfEvolutionProfile)
    if (requiresHumanApproval(profile) && approver.role === 'operator') {
      throw new Error('higher_role_approval_required')
    }

    // 1. Eval-kapu: pre_training_approval (ha van aktív eval az agenthez)
    let evalRun = null
    const activeEval = await this.evalService.findActiveForAgent(agent.id)
    if (activeEval || requiresEvalGate(profile)) {
      if (!activeEval && requiresEvalGate(profile)) {
        throw new Error('eval_required_but_missing')
      }
      if (activeEval) {
      evalRun = await this.evalService.run({
        evalId: activeEval.id,
        proposedContent: payload.proposedContent,
        agentVersion: agent.currentVersion,
        trigger: 'pre_training_approval',
      })

      // §4.4: az eval eredménye a training_tickets soron is rögzül (akár blokkol, akár nem).
      await prisma.trainingTicket.updateMany({
        where: { ticketId },
        data: { evalResult: evalRun.details ?? { passed: evalRun.passed, score: evalRun.score } },
      })

      if (!evalRun.passed && !opts.overrideEval) {
        await this.audit.append({
          actorType: 'human',
          actorId: approverId,
          agentVersion: agent.currentVersion,
          action: 'memory.write.eval_blocked',
          targetType: 'memory',
          targetId: agent.memoryId,
          modelUsed: null,
          inputRef: activeEval.id,
          outputRef: evalRun.id,
          policyDecision: `eval_failed:score=${evalRun.score.toFixed(2)}`,
          metadata: evalRun.details,
        })
        throw new Error(
          `eval_failed: score ${Math.round(evalRun.score * 100)}% — use overrideEval to proceed`,
        )
      }

      if (!evalRun.passed && opts.overrideEval) {
        await this.audit.append({
          actorType: 'human',
          actorId: approverId,
          agentVersion: agent.currentVersion,
          action: 'memory.write.eval_override',
          targetType: 'memory',
          targetId: agent.memoryId,
          modelUsed: null,
          inputRef: activeEval.id,
          outputRef: evalRun.id,
          policyDecision: `eval_override:score=${evalRun.score.toFixed(2)}`,
          metadata: evalRun.details,
        })
      }
      }
    }

    // 2. Write-gate token kiállítás
    const gateToken = await this.writeGate.issue({
      trainingTicketId: ticketId,
      agentId: agent.id,
      targetMemoryId: agent.memoryId,
      proposedContent: payload.proposedContent,
    })

    // 3. Write-gate token consume (diffHash-ellenőrzés + aláírás-verifikáció)
    await this.writeGate.consume({
      tokenId: gateToken.id,
      actualProposedContent: payload.proposedContent,
    })

    // §4.4: a kiállított token referenciája a training_tickets soron (nyers token sosem tárolt).
    await prisma.trainingTicket.updateMany({
      where: { ticketId },
      data: { writeGateTokenRef: gateToken.id },
    })

    // 4. Memória-írás — csak sikeres gate-consume után
    const currentVersion = agent.memory.currentVersion
    const maxVersionRow = await prisma.memoryVersion.aggregate({
      where: { memoryId: agent.memoryId },
      _max: { version: true },
    })
    const nextVersion = (maxVersionRow._max.version ?? 0) + 1

    if (currentVersion) {
      await prisma.memoryVersion.update({
        where: { id: currentVersion.id },
        data: { status: 'rolled_back' },
      })
    }

    const memoryVersion = await prisma.memoryVersion.create({
      data: {
        memoryId: agent.memoryId,
        version: nextVersion,
        content: payload.proposedContent,
        diffFromPrevious: currentVersion
          ? computeDiff(currentVersion.content, payload.proposedContent)
          : undefined,
        status: 'active',
        source: payload.source ?? 'training',
        approvedById: approverId,
      },
    })

    await prisma.memory.update({
      where: { id: agent.memoryId },
      data: { currentVersionId: memoryVersion.id },
    })

    await this.ticketService.transition({
      ticketId,
      toState: 'approved',
      actor: { type: 'human', userId: approverId, role: approver.role },
      agentVersion: agent.currentVersion,
    })
    await this.ticketService.transition({
      ticketId,
      toState: 'done',
      actor: { type: 'system' },
    })

    await this.audit.append({
      actorType: 'human',
      actorId: approverId,
      agentVersion: agent.currentVersion,
      action: 'memory.update',
      targetType: 'memory',
      targetId: agent.memoryId,
      modelUsed: null,
      inputRef: String(currentVersion?.version ?? 0),
      outputRef: String(nextVersion),
      policyDecision: evalRun?.passed === false
        ? `write_gate_consumed:eval_override`
        : 'write_gate_consumed',
      metadata: { writeGateTokenId: gateToken.id, evalRunId: evalRun?.id ?? null },
    })

    return { memoryVersion, writeGateTokenId: gateToken.id, evalRun }
  }

  async rollbackMemory(agentId: string, toVersion: number, actorId: string) {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: { memory: true },
    })
    if (!agent) throw new Error('Agent not found')

    const target = await prisma.memoryVersion.findUnique({
      where: { memoryId_version: { memoryId: agent.memoryId, version: toVersion } },
    })
    if (!target) throw new Error('Memory version not found')

    const active = await prisma.memoryVersion.findFirst({
      where: { memoryId: agent.memoryId, status: 'active' },
    })
    if (active) {
      await prisma.memoryVersion.update({
        where: { id: active.id },
        data: { status: 'rolled_back' },
      })
    }

    await prisma.memoryVersion.update({
      where: { id: target.id },
      data: { status: 'active' },
    })

    await prisma.memory.update({
      where: { id: agent.memoryId },
      data: { currentVersionId: target.id },
    })

    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: agent.currentVersion,
      action: 'memory.rollback',
      targetType: 'memory',
      targetId: agent.memoryId,
      modelUsed: null,
      inputRef: active ? String(active.version) : null,
      outputRef: String(toVersion),
      policyDecision: 'rollback',
      metadata: null,
    })

    return target
  }
}

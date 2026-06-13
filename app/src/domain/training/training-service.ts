import { prisma } from '@/lib/db'
import type { AuditRepository, TicketRepository } from '@/repositories/interfaces'
import type { TicketService } from '../ticket/ticket-service'
import type { WriteGateService } from '../writegate/write-gate-service'
import type { EvalService } from '../eval/eval-service'

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
  ) {}

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

    const currentContent = agent.memory.currentVersion?.content ?? ''
    const diff = computeDiff(currentContent, params.proposedContent)

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

    // Az állapotgépen át vezetjük a jóváhagyási kapuig — minden lépés auditált (4.1).
    await this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'in_review',
      actor: { type: 'system' },
    })
    return this.ticketService.transition({
      ticketId: ticket.id,
      toState: 'awaiting_human',
      actor: { type: 'system' },
    })
  }

  async approveTraining(
    ticketId: string,
    approverId: string,
    opts: { overrideEval?: boolean } = {},
  ) {
    const ticket = await this.tickets.findById(ticketId)
    if (!ticket || ticket.type !== 'training') throw new Error('Training ticket not found')
    if (ticket.state !== 'awaiting_human') throw new Error('Ticket not awaiting approval')

    const approver = await prisma.user.findUnique({ where: { id: approverId } })
    if (!approver) throw new Error('Approver not found')

    const payload = ticket.payload as { proposedContent: string; source?: string }

    const agent = await prisma.agent.findUnique({
      where: { id: ticket.agentId! },
      include: { memory: { include: { currentVersion: true } } },
    })
    if (!agent) throw new Error('Agent not found')

    // 1. Eval-kapu: pre_training_approval (ha van aktív eval az agenthez)
    let evalRun = null
    const activeEval = await this.evalService.findActiveForAgent(agent.id)
    if (activeEval) {
      evalRun = await this.evalService.run({
        evalId: activeEval.id,
        proposedContent: payload.proposedContent,
        agentVersion: agent.currentVersion,
        trigger: 'pre_training_approval',
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

import type { Ticket, UserRole } from '@prisma/client'
import { prisma } from '@/lib/db'
import { hasMinimumRole } from '@/lib/iam-policy'
import {
  requiresEvalGate,
  requiresHumanApproval,
  resolveSelfEvolutionProfile,
} from '@/lib/self-evolution-profile'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'
import type { AgentRepository, AuditRepository, TicketRepository } from '@/repositories/interfaces'
import type { TicketService } from '../ticket/ticket-service'
import type { WriteGateService } from '../writegate/write-gate-service'
import type { EvalService } from '../eval/eval-service'
import type { SelfEvolutionGuard } from './self-evolution-guard'

/**
 * A tanítási / önfejlesztési útvonal hívói kontextusa (MemoryTraining spec I8 + T11).
 *
 * A `tenantId` és a `role` MINDIG a request AKTÍV tenant-kontextusából jön
 * (`requireTenantRole`), sosem a legacy `User.tenantId` / `User.role` oszlopból:
 * egy felhasználó több tenantnak is tagja lehet, eltérő szereppel. Ugyanaz az
 * invariáns, amit a `MemoryApprovalService` (WP-6, S6) is követ.
 *
 * A `tenantId` szándékosan NEM nullable (`TenantAuthContext.activeTenantId`
 * garantáltan az): egy null-tenantú aktor MINDEN megosztott agenten átjutna a
 * tenant-kapun, és tenant-nélküli training ticketet bélyegezne — pont azt a rést
 * nyitná újra, amit ez a guard zár. Fail-closed, mint a `MemoryApprovalActor`.
 */
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

  /**
   * MemoryTraining spec I8/T11 — cross-tenant memória-olvasás/írás tiltott.
   *
   * A tenant-határ a SERVICE-ben is invariáns, nem csak a hívó Server Actionben:
   * a szerep-kapu (`requireTenantRole`) csak azt mondja meg, MILYEN JOGA van a
   * hívónak a SAJÁT tenantjában — azt nem, hogy a cél-agent egyáltalán az ő
   * tenantjához tartozik-e. A hibaüzenet szándékosan opak (`Agent not found`),
   * hogy egy másik tenant agentjének létezését se szivárogtassa.
   */
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

  /**
   * §7: minden hard-guard bukás `write_denied` audit-sort hagy. Tenant-határ-sértés
   * nélküle NÉMA lenne — pedig egy idegen agent-UUID-vel próbálkozó jóváhagyás a
   * legerősebb korai jele egy cross-tenant szondázásnak.
   */
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

  /**
   * A training-ticket tenant-határa. A `tenantId === null` sorok a tenant-bélyegzés
   * bevezetése ELŐTT keletkezett tanítási ticketek; ezeket a hívó ezután a MÖGÖTTES
   * AGENT tenantján horgonyozza le (l. {@link requireReachableAgent}), különben a
   * meglévő, jóváhagyásra váró ticketek eldobhatatlanná válnának.
   *
   * FIGYELEM — a horgony csak tenant-hoz KÖTÖTT agentre szűkít. Egy legacy,
   * tenant-nélküli ticket MEGOSZTOTT (platform-szintű) agenten továbbra is bármely
   * tenant approvere számára jóváhagyható marad; ez a megosztott agentek eleve
   * fennálló, tudatos tulajdonsága (l. a PR "Nyitott döntés" pontját), nem ez a
   * guard oldja meg. Új ticket már mindig kap tenant-bélyeget.
   */
  private assertTicketTenantScope(ticket: Pick<Ticket, 'tenantId'>, actor: TrainingActor) {
    if (ticket.tenantId !== null && ticket.tenantId !== actor.tenantId) {
      throw new Error('Training ticket not found')
    }
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
    // I8: tenant-kapu a profil-ág ELŐTT. Enélkül a `human_approval_required` vs
    // `auto_promote_not_implemented_for_profile` hibakülönbség létezés-orákulum
    // lenne egy idegen tenant ticketjére és annak önfejlesztési profiljára.
    this.assertTicketTenantScope(ticket, actor)
    if (!ticket.agentId) throw new Error('Training ticket has no agent')
    await this.requireReachableAgent(ticket.agentId, actor, { ticketId })

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
    actor: TrainingActor
  }) {
    // I8: a tenant-határ MINDEN prisma-érintés előtt dől el.
    await this.requireReachableAgent(params.agentId, params.actor)

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
      // I8: a training ticket tenant-bélyeget kap, különben tenant-nélküli sorként
      // BÁRMELY tenant approvere feloldhatná és jóváhagyhatná. Megosztott
      // (platform-szintű) agentnél a ticket ahhoz a tenanthoz tartozik, amelyik
      // a tanítást kezdeményezte.
      tenantId: agent.tenantId ?? params.actor.tenantId,
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
      createdById: params.actor.id,
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
    actor: TrainingActor,
    opts: { overrideEval?: boolean } = {},
  ) {
    const approverId = actor.id
    const ticket = await this.tickets.findById(ticketId)
    if (!ticket || ticket.type !== 'training') throw new Error('Training ticket not found')
    // I8/T11: a ticket és a mögötte lévő agent is az aktív tenantból kell látszódjon.
    // Ez a `tickets.findById` tenant-szűrő hiányának a kapuja — enélkül egy másik
    // tenant approvere egy ismert ticket-UUID-vel idegen agent memóriáját írná át.
    this.assertTicketTenantScope(ticket, actor)
    if (!ticket.agentId) throw new Error('Training ticket has no agent')
    await this.requireReachableAgent(ticket.agentId, actor, { ticketId })
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

    // A jóváhagyó létezését továbbra is ellenőrizzük (a `memory_versions.approved_by`
    // FK-ja rá mutat), de a JOGOSULTSÁGI döntés az AKTÍV tenant-szerepre épül,
    // nem a legacy `User.role` oszlopra — l. `TrainingActor`.
    const approver = await prisma.user.findUnique({ where: { id: approverId } })
    if (!approver) throw new Error('Approver not found')

    const payload = ticket.payload as { proposedContent: string; source?: string }

    const agent = await prisma.agent.findUnique({
      where: { id: ticket.agentId! },
      include: { memory: { include: { currentVersion: true } } },
    })
    if (!agent) throw new Error('Agent not found')

    const profile = resolveSelfEvolutionProfile(agent.selfEvolutionProfile)
    // §5.12.2 `human` / `higher_role` mód: legalább approver tenant-szerep kell.
    // Rangsor-alapú ellenőrzés (nem `=== 'operator'`), hogy új, alacsonyabb jogú
    // szerep bevezetése se nyisson rést a kapun (deny-by-default).
    if (requiresHumanApproval(profile) && !hasMinimumRole(actor.role, 'approver')) {
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
        agentId: agent.id,
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
          tenantId: agent.tenantId,
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
          tenantId: agent.tenantId,
          metadata: evalRun.details,
        })
      }
      }
    }

    // 2. Write-gate token kiállítás — a gate-események a jóváhagyó emberhez kötődnek.
    const gateContext = {
      tenantId: agent.tenantId,
      actorType: 'human' as const,
      actorId: approverId,
      agentVersion: agent.currentVersion,
    }
    const gateToken = await this.writeGate.issue({
      trainingTicketId: ticketId,
      agentId: agent.id,
      targetMemoryId: agent.memoryId,
      proposedContent: payload.proposedContent,
      context: gateContext,
    })

    // 3. Write-gate token consume (diffHash-ellenőrzés + aláírás-verifikáció)
    await this.writeGate.consume({
      tokenId: gateToken.id,
      actualProposedContent: payload.proposedContent,
      context: gateContext,
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
          ? computeDiff(currentVersion.content ?? '', payload.proposedContent)
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
      actor: { type: 'human', userId: approverId, role: actor.role },
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
      // §9: minden memória-esemény hordozza a tenantot.
      tenantId: agent.tenantId,
      metadata: { writeGateTokenId: gateToken.id, evalRunId: evalRun?.id ?? null },
    })

    return { memoryVersion, writeGateTokenId: gateToken.id, evalRun }
  }

  async rollbackMemory(agentId: string, toVersion: number, actor: TrainingActor) {
    const actorId = actor.id
    // I8: a rollback a memória TARTALMÁT írja felül (visszaállít egy korábbi
    // agent-utasításkészletet), ezért ugyanaz a tenant-határ vonatkozik rá, mint
    // az előre-írásra. A `rollbackMemoryVersion` (WP-8) útvonal ezt már betartja.
    await this.requireReachableAgent(agentId, actor)

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
      tenantId: agent.tenantId,
      metadata: null,
    })

    return target
  }
}

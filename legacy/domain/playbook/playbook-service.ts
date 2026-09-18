import type { Prisma, Ticket, TicketType } from '@prisma/client'
import {
  formatPlaybookRef,
  isPlaybookTransitionBlocked,
  parsePlaybookRef,
  parsePlaybookSpec,
  type PlaybookSpec,
} from '@/lib/playbook-spec'
import type { AuditRepository, PlaybookRepository } from '@/repositories/interfaces'

export class PlaybookService {
  constructor(
    private playbooks: PlaybookRepository,
    private audit: AuditRepository,
  ) {}

  async getActiveRefByName(name: string): Promise<string | null> {
    const active = await this.playbooks.getActiveVersionByName(name)
    if (!active) return null
    return formatPlaybookRef(active.playbook.name, active.version)
  }

  async resolveSpec(playbookRef: string | null | undefined): Promise<PlaybookSpec | null> {
    if (!playbookRef) return null
    const parsed = parsePlaybookRef(playbookRef)
    if (!parsed) return null
    const version = await this.playbooks.findVersionByNameAndVersion(parsed.name, parsed.version)
    if (!version) return null
    return parsePlaybookSpec(version.spec)
  }

  async auditProcessStart(params: {
    ticket: Ticket
    playbookRef: string
    actorType: 'human' | 'agent' | 'system'
    actorId: string | null
  }) {
    await this.audit.append({
      actorType: params.actorType,
      actorId: params.actorId,
      agentVersion: null,
      action: 'process.start',
      targetType: 'ticket',
      targetId: params.ticket.id,
      modelUsed: null,
      inputRef: params.ticket.type,
      outputRef: params.playbookRef,
      policyDecision: 'pinned',
      metadata: { playbookRef: params.playbookRef },
    })
  }

  async createPlaybook(input: {
    name: string
    processType: string
    spec: Prisma.JsonValue
    tenantId?: string | null
    createdById?: string
  }) {
    const { playbook, version } = await this.playbooks.createPlaybook({
      name: input.name,
      processType: input.processType,
      tenantId: input.tenantId,
      spec: input.spec,
    })

    await this.audit.append({
      actorType: input.createdById ? 'human' : 'system',
      actorId: input.createdById ?? null,
      agentVersion: null,
      action: 'playbook.create',
      targetType: 'playbook',
      targetId: playbook.id,
      modelUsed: null,
      inputRef: playbook.name,
      outputRef: `v${version.version}`,
      policyDecision: 'proposed',
      metadata: { processType: playbook.processType },
    })

    return { playbook, version }
  }

  async approveVersion(input: { versionId: string; approverId: string }) {
    const version = await this.playbooks.approveVersion(input.versionId, input.approverId)

    await this.audit.append({
      actorType: 'human',
      actorId: input.approverId,
      agentVersion: null,
      action: 'playbook.approve',
      targetType: 'playbook',
      targetId: version.playbookId,
      modelUsed: null,
      inputRef: input.versionId,
      outputRef: `v${version.version}`,
      policyDecision: 'active',
      metadata: { playbookVersionId: version.id },
    })

    return version
  }

  checkTransition(params: {
    ticket: Ticket
    from: Ticket['state']
    to: Ticket['state']
    agentRole: 'worker' | 'orchestrator'
    spec: PlaybookSpec | null
  }): { blocked: boolean; reason?: string } {
    if (!params.spec) return { blocked: false }

    const payload =
      typeof params.ticket.payload === 'object' &&
      params.ticket.payload !== null &&
      !Array.isArray(params.ticket.payload)
        ? (params.ticket.payload as Record<string, unknown>)
        : {}

    const result = isPlaybookTransitionBlocked({
      spec: params.spec,
      ticketType: params.ticket.type as TicketType,
      role: params.agentRole,
      from: params.from,
      to: params.to,
      payload,
    })

    return { blocked: result.blocked, reason: result.reason }
  }
}

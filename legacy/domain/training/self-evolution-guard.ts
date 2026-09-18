import type { AuditActorType } from '@prisma/client'
import type { AuditRepository } from '@/repositories/interfaces'

/**
 * Kemény padló (§4.6, N6): az önfejlesztési / tanítási útvonal soha nem
 * módosíthatja capabilities / agent_connectors sorokat.
 */
export class SelfEvolutionGuard {
  constructor(private audit: AuditRepository) {}

  async denyCapabilityEscalation(params: {
    agentId: string
    toolName: string
    actorType: AuditActorType
    actorId: string | null
    ticketId?: string | null
    connectorId?: string | null
  }): Promise<{ allowed: false; reason: string }> {
    await this.audit.append({
      actorType: params.actorType,
      actorId: params.actorId,
      agentVersion: null,
      action: 'training.capability_escalation_denied',
      targetType: 'agent',
      targetId: params.agentId,
      modelUsed: null,
      inputRef: params.toolName,
      outputRef: params.connectorId ?? params.ticketId ?? null,
      policyDecision: 'capability_escalation_denied',
      metadata: {
        toolName: params.toolName,
        ticketId: params.ticketId ?? null,
        connectorId: params.connectorId ?? null,
      },
    })

    return { allowed: false, reason: 'capability_escalation_denied' }
  }
}

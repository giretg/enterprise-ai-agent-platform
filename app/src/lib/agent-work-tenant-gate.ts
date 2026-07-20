import {
  evaluateTenantOperationGate,
  resolveWorkOwnerTenantId,
} from '@/lib/tenant-operation-gate'
import { repositories } from '@/repositories/postgres'

/**
 * Agent API-kulcsos utak (gateway / tool invoke) tenant-státusz kapuja.
 * A munka tulajdonosa: ticket.tenantId ?? agent.tenantId.
 */
export async function assertAgentWorkTenantOperable(params: {
  agentId: string
  ticketId?: string | null
}): Promise<{ ok: true } | { ok: false; tenantId: string; tenantStatus: string }> {
  const agent = await repositories.agents.findById(params.agentId)
  if (!agent) {
    return { ok: false, tenantId: 'missing_agent', tenantStatus: 'missing' }
  }

  let ticketTenantId: string | null = null
  if (params.ticketId) {
    const ticket = await repositories.tickets.findById(params.ticketId)
    ticketTenantId = ticket?.tenantId ?? null
  }

  const gateTenantId = resolveWorkOwnerTenantId(ticketTenantId, agent.tenantId)
  const gate = await evaluateTenantOperationGate({
    tenants: repositories.tenants,
    gateTenantId,
  })
  if (!gate.allowed) {
    return { ok: false, tenantId: gate.tenantId, tenantStatus: gate.tenantStatus }
  }
  return { ok: true }
}

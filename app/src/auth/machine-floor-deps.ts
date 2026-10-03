import { isPrivilegedAgentReader } from '@/domain/agent-definition'
import type { MachineFloorDeps } from '@/domain/client-policy/machine-floor'
import { isAvailableOnMcp } from '@/lib/agent-lifecycle'
import { repositories } from '@/repositories/postgres'
import { PostgresClientPolicyRepository } from '@/repositories/postgres/client-policy-repository'
import { PostgresMachineFloorRepository } from '@/repositories/postgres/machine-floor-repository'

const policyStore = new PostgresClientPolicyRepository()
const floors = new PostgresMachineFloorRepository()

export function machineFloorDeps(): MachineFloorDeps {
  return {
    policyStore,
    floors,
    async listVisibleAgentIds({ tenantId, userId }) {
      const membership = await repositories.tenantMemberships.findByTenantAndUser(tenantId, userId)
      if (!membership || membership.status !== 'active') return []
      const published = await repositories.agents.findMany({ tenantId, unbounded: true })
      const visible = published.filter(isAvailableOnMcp)
      if (isPrivilegedAgentReader(membership.role)) return visible.map((agent) => agent.id)
      const granted = new Set(await repositories.resourceGrants.listAgentIdsGrantedToUser({ tenantId, userId }))
      return visible.filter((agent) => granted.has(agent.id)).map((agent) => agent.id)
    },
  }
}

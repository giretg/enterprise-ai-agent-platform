import { isPrivilegedAgentReader } from '@/domain/agent-definition'
import type { MachineFloorDeps, VisibleHermesBot } from '@/domain/client-policy/machine-floor'
import { services } from '@/domain/gateway-services'
import { isAvailableOnMcp } from '@/lib/agent-lifecycle'
import { readWarehouseSettings, warehouseAccessForAgent } from '@/lib/warehouse-settings'
import { repositories } from '@/repositories/postgres'
import { PostgresClientPolicyRepository } from '@/repositories/postgres/client-policy-repository'
import { PostgresMachineFloorRepository } from '@/repositories/postgres/machine-floor-repository'

const policyStore = new PostgresClientPolicyRepository()
const floors = new PostgresMachineFloorRepository()

async function listVisibleAgentIds({ tenantId, userId }: { tenantId: string; userId: string }): Promise<string[]> {
  const membership = await repositories.tenantMemberships.findByTenantAndUser(tenantId, userId)
  if (!membership || membership.status !== 'active') return []
  const published = await repositories.agents.findMany({ tenantId, unbounded: true })
  const visible = published.filter(isAvailableOnMcp)
  if (isPrivilegedAgentReader(membership.role)) return visible.map((agent) => agent.id)
  const granted = new Set(await repositories.resourceGrants.listAgentIdsGrantedToUser({ tenantId, userId }))
  return visible.filter((agent) => granted.has(agent.id)).map((agent) => agent.id)
}

export function machineFloorDeps(): MachineFloorDeps {
  return {
    policyStore,
    floors,
    listVisibleAgentIds,
    async listVisibleBots({ tenantId, userId }) {
      const bots: VisibleHermesBot[] = []
      const warehouse = readWarehouseSettings((await repositories.tenants.findById(tenantId))?.settings)
      for (const agentId of await listVisibleAgentIds({ tenantId, userId })) {
        const definition = await services.agentDefinitions.loadAgentDefinition({ tenantId, agentId })
        if (!definition) continue
        bots.push({
          agentId: definition.agentId,
          version: definition.version,
          snapshot: {
            name: definition.snapshot.name,
            description: definition.snapshot.description,
            roleInstruction: definition.snapshot.roleInstruction,
            capabilities: definition.snapshot.capabilities,
            localRoots: definition.snapshot.localRoots,
          },
          warehouseAccess: warehouseAccessForAgent(warehouse, definition.agentId),
        })
      }
      return bots
    },
  }
}

import { canWarehouse } from '@/domain/warehouse/permissions'
import { WarehouseError } from '@/domain/warehouse/warehouse-service'
import { createLiveRateLimiter, type MiniAppLiveDataDeps } from '@/domain/mini-app/live-data'
import { warehouseService } from '@/lib/warehouse'
import { readWarehouseSettings, warehouseAccessForAgent } from '@/lib/warehouse-settings'
import { repositories } from '@/repositories/postgres'

/** #1083: az élő adat éles függőségei; a mini app tartomány az adattárházat ezen át éri el. */
export const miniAppLiveDeps: MiniAppLiveDataDeps = {
  async findMembership(tenantId, userId) {
    const membership = await repositories.tenantMemberships.findByTenantAndUser(tenantId, userId)
    return membership ? { role: membership.role, status: membership.status } : null
  },
  canReadWarehouse: (role) => canWarehouse(role, 'read'),
  async agentAccess({ tenantId, agentId }) {
    const tenant = await repositories.tenants.findById(tenantId)
    return warehouseAccessForAgent(readWarehouseSettings(tenant?.settings), agentId)
  },
  async findOwnerAgent({ tenantId, agentId }) {
    const agent = await repositories.agents.findById(agentId, tenantId)
    return agent ? { retiredAt: agent.retiredAt ?? null } : null
  },
  runBoundQuery: (actor, input) => warehouseService().runBoundQuery({ ...actor, channel: 'mini_app' }, input),
  errorCode: (error) => (error instanceof WarehouseError ? error.code : 'live_data_unavailable'),
}

export const miniAppLiveRateLimit = createLiveRateLimiter()

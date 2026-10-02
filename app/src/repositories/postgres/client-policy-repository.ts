import { prisma } from '@/lib/db'
import type { ClientPolicyStore } from '@/domain/client-policy/policy-service'
import type { PolicyRow } from '@/domain/client-policy/resolve-effective-policy'

export class PostgresClientPolicyRepository implements ClientPolicyStore {
  async findRows(input: { tenantId: string; userId: string; agentId: string | null }): Promise<PolicyRow[]> {
    const scopeIds = [input.tenantId, input.userId, ...(input.agentId ? [input.agentId] : [])]
    const rows = await prisma.clientPolicy.findMany({
      where: { tenantId: input.tenantId, scopeId: { in: scopeIds } },
    })
    return rows.flatMap((r) =>
      r.scope === 'tenant' || r.scope === 'user' || r.scope === 'agent'
        ? [{ scope: r.scope, scopeId: r.scopeId, preset: r.preset, capabilities: r.capabilities, toolOverrides: r.toolOverrides, version: r.version }]
        : [],
    )
  }
}

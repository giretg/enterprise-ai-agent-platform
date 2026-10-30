'use server'

import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'

/** Only the active tenant's internal agents can be offered for publication. */
export async function listConnectorAgentsForPublishing(input: { connectorId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const connectorId = z.string().uuid().parse(input.connectorId)
    // Updating connectors is also available to operators/approvers; publishing is admin-only.
    if (user.activeTenantRole !== 'admin') return ok([])
    const agents = await prisma.agent.findMany({
      where: {
        tenantId: user.activeTenantId,
        kind: 'internal',
        status: { not: 'retired' },
        agentConnectors: {
          some: {
            connectorId,
            connector: {
              lifecycleState: 'active',
              tenantId: user.activeTenantId,
            },
          },
        },
      },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    })
    return ok(agents)
  } catch {
    return fail('A kapcsolat módosítása elmentve, de az érintett munkatársakat nem sikerült betölteni. A munkatársak oldalán tudod közzétenni őket.')
  }
}

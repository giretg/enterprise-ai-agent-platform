import { prisma } from '@/lib/db'

/** Vezérlőpult: megszakadt közös postafiókok (admin-értesítés). */
export async function listBrokenTenantMailboxes(tenantId: string): Promise<Array<{ connectorId: string; address: string | null }>> {
  const rows = await prisma.connectorGrant.findMany({
    where: {
      tenantId,
      ownerType: 'tenant',
      status: 'expired',
      connector: { lifecycleState: 'active', authMode: 'service' },
    },
    select: { connectorId: true, accountLabel: true },
  })
  return rows.map((row) => ({ connectorId: row.connectorId, address: row.accountLabel }))
}

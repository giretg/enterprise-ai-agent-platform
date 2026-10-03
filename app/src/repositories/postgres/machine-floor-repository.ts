import { prisma } from '@/lib/db'
import type { MachineFloorStore } from '@/domain/client-policy/machine-floor'

export class PostgresMachineFloorRepository implements MachineFloorStore {
  async find(input: { tenantId: string; userId: string }) {
    const row = await prisma.clientMachineFloor.findUnique({
      where: { tenantId_userId: { tenantId: input.tenantId, userId: input.userId } },
      select: { installId: true },
    })
    return row
  }

  async save(input: { tenantId: string; userId: string; installId: string; managedDirHash: string }) {
    const data = { installId: input.installId, managedDirHash: input.managedDirHash }
    await prisma.clientMachineFloor.upsert({
      where: { tenantId_userId: { tenantId: input.tenantId, userId: input.userId } },
      create: { tenantId: input.tenantId, userId: input.userId, ...data },
      update: data,
    })
  }

  async expectedHash(input: { tenantId: string; userId: string; installId: string }) {
    const row = await prisma.clientMachineFloor.findUnique({
      where: { tenantId_userId: { tenantId: input.tenantId, userId: input.userId } },
      select: { installId: true, managedDirHash: true },
    })
    if (!row || row.installId !== input.installId) return null
    return row.managedDirHash
  }
}

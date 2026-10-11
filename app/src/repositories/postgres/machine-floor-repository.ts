import { prisma } from '@/lib/db'
import type { MachineFloorStore } from '@/domain/client-policy/machine-floor'

export class PostgresMachineFloorRepository implements MachineFloorStore {
  async getOrCreateInstallId(input: { tenantId: string; userId: string; installId: string }) {
    const row = await prisma.clientMachineFloor.upsert({
      where: { tenantId_userId: { tenantId: input.tenantId, userId: input.userId } },
      create: { tenantId: input.tenantId, userId: input.userId, installId: input.installId, managedDirHash: '' },
      // A nem üres update natív, atomi upsertet kér; az installId változatlan marad.
      update: { userId: input.userId },
      select: { installId: true },
    })
    return row.installId
  }

  async save(input: { tenantId: string; userId: string; installId: string; managedDirHash: string; platform?: 'posix' | 'windows' }) {
    const windows = input.platform === 'windows'
    const data = windows
      ? { installId: input.installId, windowsManagedDirHash: input.managedDirHash }
      : { installId: input.installId, managedDirHash: input.managedDirHash }
    await prisma.clientMachineFloor.upsert({
      where: { tenantId_userId: { tenantId: input.tenantId, userId: input.userId } },
      create: {
        tenantId: input.tenantId,
        userId: input.userId,
        installId: input.installId,
        managedDirHash: windows ? '' : input.managedDirHash,
        windowsManagedDirHash: windows ? input.managedDirHash : null,
      },
      update: data,
    })
  }

  async issuedHashes(input: { tenantId: string; userId: string; installId: string }) {
    const row = await prisma.clientMachineFloor.findUnique({
      where: { tenantId_userId: { tenantId: input.tenantId, userId: input.userId } },
      select: { installId: true, managedDirHash: true, windowsManagedDirHash: true },
    })
    if (!row || row.installId !== input.installId) return null
    return [row.managedDirHash, row.windowsManagedDirHash].filter((hash): hash is string => !!hash && hash.length > 0)
  }
}

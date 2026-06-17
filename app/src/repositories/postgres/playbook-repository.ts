import type { Playbook, PlaybookVersion, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { PlaybookRepository, PlaybookWithVersions } from '../interfaces'

export class PostgresPlaybookRepository implements PlaybookRepository {
  async list(): Promise<PlaybookWithVersions[]> {
    return prisma.playbook.findMany({
      orderBy: { createdAt: 'desc' },
      include: { versions: { orderBy: { version: 'desc' } } },
    })
  }

  async findByName(name: string): Promise<PlaybookWithVersions | null> {
    return prisma.playbook.findFirst({
      where: { name },
      include: { versions: { orderBy: { version: 'desc' } } },
    })
  }

  async findVersionByNameAndVersion(
    name: string,
    version: number,
  ): Promise<(PlaybookVersion & { playbook: Playbook }) | null> {
    const playbook = await prisma.playbook.findFirst({ where: { name } })
    if (!playbook) return null
    const row = await prisma.playbookVersion.findUnique({
      where: { playbookId_version: { playbookId: playbook.id, version } },
      include: { playbook: true },
    })
    return row
  }

  async createPlaybook(input: {
    name: string
    processType: string
    tenantId?: string | null
    spec: Prisma.JsonValue
  }): Promise<{ playbook: Playbook; version: PlaybookVersion }> {
    return prisma.$transaction(async (tx) => {
      const playbook = await tx.playbook.create({
        data: {
          name: input.name,
          processType: input.processType,
          tenantId: input.tenantId ?? null,
        },
      })
      const version = await tx.playbookVersion.create({
        data: {
          playbookId: playbook.id,
          version: 1,
          spec: input.spec as Prisma.InputJsonValue,
          status: 'proposed',
        },
      })
      return { playbook, version }
    })
  }

  async approveVersion(versionId: string, approverId: string): Promise<PlaybookVersion> {
    return prisma.$transaction(async (tx) => {
      const target = await tx.playbookVersion.findUnique({ where: { id: versionId } })
      if (!target) throw new Error('Playbook version not found')

      await tx.playbookVersion.updateMany({
        where: { playbookId: target.playbookId, status: 'active' },
        data: { status: 'retired' },
      })

      return tx.playbookVersion.update({
        where: { id: versionId },
        data: { status: 'active', approvedById: approverId },
      })
    })
  }

  async getActiveVersion(playbookId: string): Promise<PlaybookVersion | null> {
    return prisma.playbookVersion.findFirst({
      where: { playbookId, status: 'active' },
      orderBy: { version: 'desc' },
    })
  }

  async getActiveVersionByName(name: string): Promise<(PlaybookVersion & { playbook: Playbook }) | null> {
    const playbook = await prisma.playbook.findFirst({ where: { name } })
    if (!playbook) return null
    const version = await this.getActiveVersion(playbook.id)
    if (!version) return null
    return { ...version, playbook }
  }
}

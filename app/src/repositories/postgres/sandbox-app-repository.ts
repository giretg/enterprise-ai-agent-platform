import type { SandboxApp, SandboxAppVersion } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { SandboxAppRepository, SandboxAppWithLatestVersion } from '../interfaces'

function mapWithLatestVersion(
  app: SandboxApp & { versions: SandboxAppVersion[] },
): SandboxAppWithLatestVersion {
  return app
}

export class PostgresSandboxAppRepository implements SandboxAppRepository {
  async findByIdWithLatestVersion(appId: string): Promise<SandboxAppWithLatestVersion | null> {
    const app = await prisma.sandboxApp.findUnique({
      where: { id: appId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    })
    return app ? mapWithLatestVersion(app) : null
  }

  async findLatestByTicketId(ticketId: string): Promise<SandboxAppWithLatestVersion | null> {
    const version = await prisma.sandboxAppVersion.findFirst({
      where: { sourceTicketId: ticketId },
      orderBy: { createdAt: 'desc' },
      include: {
        app: {
          include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
        },
      },
    })
    return version ? mapWithLatestVersion(version.app) : null
  }

  async createFromTicket(input: {
    name: string
    htmlContent: string
    htmlHash: string
    sourceTicketId: string
    createdBy: string
    tenantId: string | null
  }): Promise<SandboxAppWithLatestVersion> {
    const app = await prisma.sandboxApp.create({
      data: {
        name: input.name,
        level: 'A0',
        status: 'active',
        tenantId: input.tenantId,
        createdBy: input.createdBy,
        versions: {
          create: {
            version: 1,
            htmlContent: input.htmlContent,
            htmlHash: input.htmlHash,
            sourceTicketId: input.sourceTicketId,
            createdBy: input.createdBy,
          },
        },
      },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    })

    return mapWithLatestVersion(app)
  }

  async addVersion(input: {
    appId: string
    htmlContent: string
    htmlHash: string
    sourceTicketId: string
    createdBy: string
  }): Promise<SandboxAppWithLatestVersion> {
    const latest = await prisma.sandboxAppVersion.findFirst({
      where: { appId: input.appId },
      orderBy: { version: 'desc' },
      select: { version: true },
    })

    await prisma.sandboxAppVersion.create({
      data: {
        appId: input.appId,
        version: (latest?.version ?? 0) + 1,
        htmlContent: input.htmlContent,
        htmlHash: input.htmlHash,
        sourceTicketId: input.sourceTicketId,
        createdBy: input.createdBy,
      },
    })

    const app = await this.findByIdWithLatestVersion(input.appId)
    if (!app) throw new Error('Sandbox app not found after version creation')
    return app
  }
}

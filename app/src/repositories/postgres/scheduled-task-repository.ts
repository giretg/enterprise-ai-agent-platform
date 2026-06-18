import type {
  Prisma,
  ScheduledTask,
  ScheduledTaskKind,
  ScheduledTaskRecurrence,
  ScheduledTaskStatus,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ScheduledTaskRepository } from '../interfaces'

export class PostgresScheduledTaskRepository implements ScheduledTaskRepository {
  async findMany(filter?: {
    tenantId?: string | null
    agentId?: string
    limit?: number
  }): Promise<ScheduledTask[]> {
    const where: Prisma.ScheduledTaskWhereInput = {}
    if (filter && 'tenantId' in filter) where.tenantId = filter.tenantId
    if (filter?.agentId) where.agentId = filter.agentId

    return prisma.scheduledTask.findMany({
      where,
      orderBy: { nextRunAt: 'desc' },
      take: filter?.limit ?? 100,
    })
  }

  async findDue(now: Date, limit: number): Promise<ScheduledTask[]> {
    return prisma.scheduledTask.findMany({
      where: {
        status: 'active',
        nextRunAt: { lte: now },
      },
      orderBy: { nextRunAt: 'asc' },
      take: limit,
    })
  }

  async create(data: {
    tenantId: string | null
    kind?: ScheduledTaskKind
    title: string
    agentId: string
    createdById: string
    payload: Prisma.InputJsonValue
    runAsUserId?: string | null
    runAsAuthorizedAt?: Date | null
    runAsAuthorizedById?: string | null
    nextRunAt: Date
    recurrence?: ScheduledTaskRecurrence
    maxRuns?: number | null
  }): Promise<ScheduledTask> {
    return prisma.scheduledTask.create({
      data: {
        tenantId: data.tenantId,
        kind: data.kind ?? 'agent_task',
        title: data.title,
        agentId: data.agentId,
        createdById: data.createdById,
        payload: data.payload,
        runAsUserId: data.runAsUserId ?? null,
        runAsAuthorizedAt: data.runAsAuthorizedAt ?? null,
        runAsAuthorizedById: data.runAsAuthorizedById ?? null,
        nextRunAt: data.nextRunAt,
        recurrence: data.recurrence ?? 'none',
        maxRuns: data.maxRuns ?? null,
      },
    })
  }

  async claimDue(id: string, now: Date): Promise<ScheduledTask | null> {
    const updated = await prisma.scheduledTask.updateMany({
      where: {
        id,
        status: 'active',
        nextRunAt: { lte: now },
      },
      data: { status: 'materializing' },
    })
    if (updated.count !== 1) return null
    return this.findById(id)
  }

  async markMaterialized(
    id: string,
    ticketId: string,
    data: {
      status: ScheduledTaskStatus
      runCount: number
      lastRunAt: Date
      materializedAt: Date
      nextRunAt: Date
    },
  ): Promise<ScheduledTask | null> {
    const updated = await prisma.scheduledTask.updateMany({
      where: { id, status: 'materializing' },
      data: {
        status: data.status,
        materializedTicketId: ticketId,
        materializedAt: data.materializedAt,
        lastRunAt: data.lastRunAt,
        nextRunAt: data.nextRunAt,
        runCount: data.runCount,
      },
    })
    if (updated.count !== 1) return null
    return this.findById(id)
  }

  async revoke(id: string): Promise<ScheduledTask> {
    return prisma.scheduledTask.update({
      where: { id },
      data: { status: 'revoked' },
    })
  }

  async findById(id: string): Promise<ScheduledTask | null> {
    return prisma.scheduledTask.findUnique({ where: { id } })
  }

  async findStaleMaterializing(cutoff: Date, limit: number): Promise<ScheduledTask[]> {
    return prisma.scheduledTask.findMany({
      where: {
        status: 'materializing',
        updatedAt: { lte: cutoff },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    })
  }

  async reclaimMaterializing(id: string): Promise<ScheduledTask | null> {
    const updated = await prisma.scheduledTask.updateMany({
      where: { id, status: 'materializing' },
      data: { status: 'active' },
    })
    if (updated.count !== 1) return null
    return this.findById(id)
  }
}

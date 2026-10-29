import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { InstallationUpsert, MemberInsert, ScheduledTaskStore, TaskInsert } from '@/domain/scheduled-task/scheduled-task-service'

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export class PostgresScheduledTaskRepository implements ScheduledTaskStore {
  countActiveOwned(tenantId: string, userId: string) {
    return prisma.scheduledTask.count({ where: { tenantId, ownerUserId: userId, status: { not: 'archived' } } })
  }

  createTask(data: TaskInsert, members: MemberInsert[]) {
    return prisma.scheduledTask.create({ data: { ...data, members: { create: members } } })
  }

  findTask(tenantId: string, taskId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) return Promise.resolve(null)
    return prisma.scheduledTask.findFirst({ where: { id: taskId, tenantId } })
  }

  listTasks(input: Parameters<ScheduledTaskStore['listTasks']>[0]) {
    return prisma.scheduledTask.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.includeArchived ? {} : { status: { not: 'archived' } }),
        ...(input.userId ? { OR: [{ ownerUserId: input.userId }, { members: { some: { userId: input.userId } } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: input.limit,
    })
  }

  listAudienceTasks(tenantId: string, agentIds: string[]) {
    return prisma.scheduledTask.findMany({
      where: { tenantId, agentId: { in: agentIds }, audience: 'agent_operators', kind: { in: ['team', 'shared'] }, status: { not: 'archived' } },
      take: 200,
    })
  }

  async updateTask(input: Parameters<ScheduledTaskStore['updateTask']>[0]) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.scheduledTask.updateMany({
        where: { id: input.taskId, tenantId: input.tenantId, version: input.expectedVersion },
        data: { ...input.data, version: { increment: 1 } },
      })
      if (!updated.count) return null
      const nextVersion = input.expectedVersion + 1
      if (input.reconsent) {
        // D15: a szerkesztő elfogadja a saját változtatását, a többi tag újra dönt.
        await tx.scheduledTaskMember.updateMany({ where: { taskId: input.taskId, userId: { not: input.ownerUserId }, state: 'active' }, data: { state: 'needs_reconsent' } })
        await tx.scheduledTaskMember.updateMany({ where: { taskId: input.taskId, userId: input.ownerUserId }, data: { acceptedVersion: nextVersion } })
      } else {
        await tx.scheduledTaskMember.updateMany({ where: { taskId: input.taskId, acceptedVersion: input.expectedVersion }, data: { acceptedVersion: nextVersion } })
      }
      return tx.scheduledTask.findFirst({ where: { id: input.taskId, tenantId: input.tenantId } })
    })
  }

  listMembers(taskIds: string[]) {
    if (!taskIds.length) return Promise.resolve([])
    return prisma.scheduledTaskMember.findMany({ where: { taskId: { in: taskIds } }, orderBy: { createdAt: 'asc' } })
  }

  upsertMember(taskId: string, member: MemberInsert) {
    return prisma.scheduledTaskMember.upsert({
      where: { taskId_userId: { taskId, userId: member.userId } },
      create: { taskId, ...member },
      update: { state: member.state, acceptedVersion: member.acceptedVersion, invitedById: member.invitedById },
    })
  }

  async createMemberIfMissing(taskId: string, member: MemberInsert) {
    await prisma.scheduledTaskMember.createMany({ data: [{ taskId, ...member }], skipDuplicates: true })
  }

  listInstallations(input: Parameters<ScheduledTaskStore['listInstallations']>[0]) {
    if (!input.taskIds.length) return Promise.resolve([])
    return prisma.scheduledTaskInstallation.findMany({
      where: {
        taskId: { in: input.taskIds },
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.clientType ? { clientType: input.clientType } : {}),
        ...(input.clientInstanceId ? { clientInstanceId: input.clientInstanceId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 2000,
    })
  }

  upsertInstallation(input: InstallationUpsert) {
    const data = {
      userId: input.userId,
      installedScheduleHash: input.installedScheduleHash,
      installedStubHash: input.installedStubHash,
      installedVersion: input.installedVersion,
      locallyDisabled: input.locallyDisabled,
      lastSeenAt: input.now,
      lastSyncAt: input.now,
      removedAt: null,
    }
    return prisma.scheduledTaskInstallation.upsert({
      where: { taskId_clientType_clientInstanceId_externalId: { taskId: input.taskId, clientType: input.clientType, clientInstanceId: input.clientInstanceId, externalId: input.externalId } },
      create: { taskId: input.taskId, clientType: input.clientType, clientInstanceId: input.clientInstanceId, externalId: input.externalId, ...data },
      update: data,
    })
  }

  async markInstallationsRemoved(input: Parameters<ScheduledTaskStore['markInstallationsRemoved']>[0]) {
    const result = await prisma.scheduledTaskInstallation.updateMany({
      where: {
        taskId: input.taskId,
        userId: input.userId,
        removedAt: null,
        ...(input.clientType ? { clientType: input.clientType } : {}),
        ...(input.clientInstanceId ? { clientInstanceId: input.clientInstanceId } : {}),
        ...(input.externalId ? { externalId: input.externalId } : {}),
      },
      data: { removedAt: input.now },
    })
    return result.count
  }

  async touchInstallations(ids: string[], data: { lastSeenAt: Date; lastSyncAt?: Date }) {
    if (ids.length) await prisma.scheduledTaskInstallation.updateMany({ where: { id: { in: ids } }, data })
  }

  async insertRun(data: Parameters<ScheduledTaskStore['insertRun']>[0]) {
    try {
      return await prisma.scheduledTaskRun.create({ data })
    } catch (error) {
      if (isUniqueViolation(error)) return null
      throw error
    }
  }

  async reviveMissedRun(input: Parameters<ScheduledTaskStore['reviveMissedRun']>[0]) {
    const updated = await prisma.scheduledTaskRun.updateMany({
      where: { taskId: input.taskId, slot: input.slot, claimKey: input.claimKey, status: 'missed' },
      data: { status: 'running', catchUp: true, runnerUserId: input.runnerUserId, installationId: input.installationId, taskVersion: input.taskVersion, definitionVersionId: input.definitionVersionId, startedAt: new Date() },
    })
    if (!updated.count) return null
    return prisma.scheduledTaskRun.findFirst({ where: { taskId: input.taskId, slot: input.slot, claimKey: input.claimKey } })
  }

  findRun(runId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return Promise.resolve(null)
    return prisma.scheduledTaskRun.findUnique({ where: { id: runId } })
  }

  findRunsAtSlots(keys: Array<{ taskId: string; slot: Date; claimKey: string }>) {
    if (!keys.length) return Promise.resolve([])
    return prisma.scheduledTaskRun.findMany({ where: { OR: keys.map((key) => ({ taskId: key.taskId, slot: key.slot, claimKey: key.claimKey })) } })
  }

  async finishRun(input: Parameters<ScheduledTaskStore['finishRun']>[0]) {
    const updated = await prisma.scheduledTaskRun.updateMany({
      where: { id: input.runId, runnerUserId: input.runnerUserId, status: 'running' },
      data: { status: input.status, summary: input.summary, finishedAt: input.now },
    })
    return updated.count ? prisma.scheduledTaskRun.findUnique({ where: { id: input.runId } }) : null
  }

  listRuns(input: { taskIds: string[]; limit: number }) {
    if (!input.taskIds.length) return Promise.resolve([])
    return prisma.scheduledTaskRun.findMany({ where: { taskId: { in: input.taskIds } }, orderBy: { slot: 'desc' }, take: Math.min(input.limit, 2000) })
  }
}

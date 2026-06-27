import { Prisma, type MonitorDefinition, type MonitorRun, type MonitorSignal, type MonitorStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import type {
  CreateMonitorInput,
  MonitorRepository,
  MonitorRunUpdate,
  MonitorSignalUpsert,
  StaleBacklogTicket,
  UpdateMonitorInput,
  UpcomingTicketDeadline,
} from '../interfaces'

const TERMINAL_STATES = ['done', 'rejected'] as const

export class PostgresMonitorRepository implements MonitorRepository {
  async findMany(filter?: {
    tenantId?: string
    status?: MonitorStatus
    limit?: number
  }): Promise<MonitorDefinition[]> {
    return prisma.monitorDefinition.findMany({
      where: {
        ...(filter?.tenantId ? { tenantId: filter.tenantId } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: { nextSweepAt: 'asc' },
      take: filter?.limit ?? 100,
    })
  }

  async findById(id: string): Promise<MonitorDefinition | null> {
    return prisma.monitorDefinition.findUnique({ where: { id } })
  }

  async findDue(now: Date, limit: number): Promise<MonitorDefinition[]> {
    return prisma.monitorDefinition.findMany({
      where: {
        status: 'active',
        nextSweepAt: { lte: now },
        lockToken: null,
      },
      orderBy: { nextSweepAt: 'asc' },
      take: limit,
    })
  }

  async create(data: CreateMonitorInput): Promise<MonitorDefinition> {
    return prisma.monitorDefinition.create({
      data: {
        tenantId: data.tenantId,
        kind: data.kind,
        title: data.title,
        description: data.description ?? null,
        intervalSeconds: data.intervalSeconds,
        nextSweepAt: data.nextSweepAt,
        catchupPolicy: data.catchupPolicy ?? 'run_late',
        catchupWindowSec: data.catchupWindowSec ?? 900,
        collectorConfig: data.collectorConfig ?? {},
        filterConfig: data.filterConfig ?? {},
        cooldownSeconds: data.cooldownSeconds ?? 86_400,
        dedupKeyTemplate: data.dedupKeyTemplate ?? null,
        openTicketType: data.openTicketType ?? 'monitor_alert',
        escalateAgentId: data.escalateAgentId ?? null,
        perRunBudgetUsd:
          data.perRunBudgetUsd != null ? new Prisma.Decimal(data.perRunBudgetUsd) : null,
        notifyChannel: data.notifyChannel ?? null,
        createdById: data.createdById,
      },
    })
  }

  async update(id: string, data: UpdateMonitorInput): Promise<MonitorDefinition> {
    return prisma.monitorDefinition.update({
      where: { id },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.intervalSeconds !== undefined ? { intervalSeconds: data.intervalSeconds } : {}),
        ...(data.collectorConfig !== undefined ? { collectorConfig: data.collectorConfig } : {}),
        ...(data.filterConfig !== undefined ? { filterConfig: data.filterConfig } : {}),
        ...(data.cooldownSeconds !== undefined ? { cooldownSeconds: data.cooldownSeconds } : {}),
        ...(data.dedupKeyTemplate !== undefined ? { dedupKeyTemplate: data.dedupKeyTemplate } : {}),
        ...(data.escalateAgentId !== undefined ? { escalateAgentId: data.escalateAgentId } : {}),
        ...(data.perRunBudgetUsd !== undefined
          ? { perRunBudgetUsd: data.perRunBudgetUsd != null ? new Prisma.Decimal(data.perRunBudgetUsd) : null }
          : {}),
        ...(data.notifyChannel !== undefined ? { notifyChannel: data.notifyChannel } : {}),
      },
    })
  }

  async revoke(id: string): Promise<MonitorDefinition> {
    return prisma.monitorDefinition.update({ where: { id }, data: { status: 'revoked' } })
  }

  async claim(id: string, lockToken: string, now: Date): Promise<MonitorDefinition | null> {
    const updated = await prisma.monitorDefinition.updateMany({
      where: { id, status: 'active', nextSweepAt: { lte: now }, lockToken: null },
      data: { lockToken, lockedAt: now },
    })
    if (updated.count !== 1) return null
    return this.findById(id)
  }

  async release(
    id: string,
    lockToken: string,
    data: { nextSweepAt: Date; lastSweepAt: Date },
  ): Promise<void> {
    await prisma.monitorDefinition.updateMany({
      where: { id, lockToken },
      data: { lockToken: null, lockedAt: null, nextSweepAt: data.nextSweepAt, lastSweepAt: data.lastSweepAt },
    })
  }

  async createRun(monitorId: string, scheduledFor: Date): Promise<MonitorRun | null> {
    try {
      return await prisma.monitorRun.create({
        data: { monitorId, scheduledFor, outcome: 'quiet' },
      })
    } catch (error) {
      // @@unique([monitorId, scheduledFor]) ütközés → ezt a periódust már elkezdte
      // egy másik worker (dupla-fire védelem, §4.11.7).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return null
      }
      throw error
    }
  }

  async updateRun(id: string, data: MonitorRunUpdate): Promise<MonitorRun> {
    return prisma.monitorRun.update({
      where: { id },
      data: {
        outcome: data.outcome,
        finishedAt: data.finishedAt,
        signalCount: data.signalCount,
        matchedCount: data.matchedCount,
        suppressedCount: data.suppressedCount,
        openedTicketIds: data.openedTicketIds,
        llmInvoked: data.llmInvoked,
        costUsd: data.costUsd != null ? new Prisma.Decimal(data.costUsd) : null,
        error: data.error ?? null,
      },
    })
  }

  async upsertSignal(
    monitorId: string,
    dedupKey: string,
    data: MonitorSignalUpsert,
  ): Promise<MonitorSignal> {
    return prisma.monitorSignal.upsert({
      where: { monitorId_dedupKey: { monitorId, dedupKey } },
      create: {
        monitorId,
        dedupKey,
        severity: data.severity,
        payload: data.payload,
        firstSeenAt: data.now,
        lastSeenAt: data.now,
      },
      update: { severity: data.severity, payload: data.payload, lastSeenAt: data.now },
    })
  }

  async markSignalEscalated(id: string, ticketId: string, now: Date): Promise<void> {
    await prisma.monitorSignal.update({
      where: { id },
      data: { lastEscalatedAt: now, escalatedTicketId: ticketId },
    })
  }

  async findStaleLocked(cutoff: Date, limit: number): Promise<MonitorDefinition[]> {
    return prisma.monitorDefinition.findMany({
      where: { lockToken: { not: null }, lockedAt: { lte: cutoff } },
      orderBy: { lockedAt: 'asc' },
      take: limit,
    })
  }

  async releaseLock(id: string): Promise<void> {
    await prisma.monitorDefinition.updateMany({
      where: { id, lockToken: { not: null } },
      data: { lockToken: null, lockedAt: null },
    })
  }

  async collectStaleBacklogTickets(
    tenantId: string,
    updatedBefore: Date,
    limit: number,
  ): Promise<StaleBacklogTicket[]> {
    const STALE_STATES = ['awaiting_human', 'ready'] as const
    const rows = await prisma.ticket.findMany({
      where: {
        tenantId,
        state: { in: [...STALE_STATES] },
        updatedAt: { lte: updatedBefore },
        source: { not: 'test' },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true, tenantId: true, title: true, state: true, updatedAt: true, dueBy: true },
    })
    return rows.map((row) => ({
      ticketId: row.id,
      tenantId: row.tenantId,
      title: row.title,
      state: row.state,
      updatedAt: row.updatedAt,
      dueBy: row.dueBy,
    }))
  }

  async findRuns(monitorId: string, limit: number): Promise<MonitorRun[]> {
    return prisma.monitorRun.findMany({
      where: { monitorId },
      orderBy: { startedAt: 'desc' },
      take: limit,
    })
  }

  async findSignalsByMonitor(monitorId: string, limit: number): Promise<MonitorSignal[]> {
    return prisma.monitorSignal.findMany({
      where: { monitorId },
      orderBy: { lastSeenAt: 'desc' },
      take: limit,
    })
  }

  async collectUpcomingTicketDeadlines(
    tenantId: string,
    now: Date,
    withinSeconds: number,
    limit: number,
  ): Promise<UpcomingTicketDeadline[]> {
    const horizon = new Date(now.getTime() + withinSeconds * 1000)
    const rows = await prisma.ticket.findMany({
      where: {
        tenantId,
        dueBy: { not: null, lte: horizon },
        state: { notIn: [...TERMINAL_STATES] },
        source: { not: 'test' },
      },
      orderBy: { dueBy: 'asc' },
      take: limit,
      select: { id: true, tenantId: true, title: true, dueBy: true, state: true },
    })
    return rows.flatMap((row) =>
      row.dueBy
        ? [{ ticketId: row.id, tenantId: row.tenantId, title: row.title, dueBy: row.dueBy, state: row.state }]
        : [],
    )
  }
}

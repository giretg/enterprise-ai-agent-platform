import type {
  Prisma,
  ScheduledTask,
  ScheduledTaskKind,
  ScheduledTaskRecurrence,
  ScheduledTaskStatus,
} from '@prisma/client'
import type {
  AuditRepository,
  ScheduledTaskRepository,
  TicketRepository,
} from '@/repositories/interfaces'
import { buildRunAsAuthorization } from '@/lib/run-as-payload'

type MaterializeResult =
  | { scheduledTaskId: string; status: 'materialized'; ticketId: string }
  | { scheduledTaskId: string; status: 'skipped' }

type CreateScheduledAgentTaskParams = {
  tenantId: string | null
  agentId: string
  title: string
  content: string
  createdById: string
  nextRunAt: Date
  kind?: ScheduledTaskKind
  recurrence?: ScheduledTaskRecurrence
  maxRuns?: number | null
  authorizeRunAs?: boolean
  conversationId?: string | null
  attachmentDocumentIds?: string[]
  payload?: Record<string, unknown>
}

const recurrenceLabels: Record<ScheduledTaskRecurrence, string> = {
  none: 'none',
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
}

function objectPayload(payload: Prisma.JsonValue): Record<string, unknown> {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>) }
  }
  return {}
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function scheduledTaskRunAsPayload(task: ScheduledTask): Record<string, unknown> {
  if (!task.runAsUserId || !task.runAsAuthorizedAt) return {}
  if (task.runAsAuthorizedById !== task.runAsUserId) return {}
  return buildRunAsAuthorization({
    userId: task.runAsUserId,
    authorizedAt: task.runAsAuthorizedAt.toISOString(),
  })
}

export function addRecurrence(date: Date, recurrence: ScheduledTaskRecurrence): Date | null {
  if (recurrence === 'none') return null
  const next = new Date(date)
  if (recurrence === 'daily') next.setUTCDate(next.getUTCDate() + 1)
  if (recurrence === 'weekly') next.setUTCDate(next.getUTCDate() + 7)
  if (recurrence === 'monthly') {
    const day = next.getUTCDate()
    next.setUTCDate(1)
    next.setUTCMonth(next.getUTCMonth() + 1)
    const lastDayOfTargetMonth = new Date(
      Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
    ).getUTCDate()
    next.setUTCDate(Math.min(day, lastDayOfTargetMonth))
  }
  return next
}

function nextRunAfter(
  scheduledRunAt: Date,
  recurrence: ScheduledTaskRecurrence,
  now: Date,
): Date | null {
  let next = addRecurrence(scheduledRunAt, recurrence)
  while (next && next <= now) {
    next = addRecurrence(next, recurrence)
  }
  return next
}

function materializedTaskState(
  task: ScheduledTask,
  now: Date,
): { status: ScheduledTaskStatus; nextRunAt: Date; runCount: number } {
  const runCount = task.runCount + 1
  const nextRunAt = nextRunAfter(task.nextRunAt, task.recurrence, now)
  const maxRunsReached = task.maxRuns !== null && runCount >= task.maxRuns
  if (!nextRunAt || maxRunsReached) {
    return { status: 'materialized', nextRunAt: task.nextRunAt, runCount }
  }
  return { status: 'active', nextRunAt, runCount }
}

export class ScheduledTaskService {
  constructor(
    private scheduledTasks: ScheduledTaskRepository,
    private tickets: TicketRepository,
    private audit: AuditRepository,
  ) {}

  async list(params: {
    tenantId?: string | null
    agentId?: string
    limit?: number
  }): Promise<ScheduledTask[]> {
    return this.scheduledTasks.findMany(params)
  }

  async createAgentTask(params: CreateScheduledAgentTaskParams): Promise<ScheduledTask> {
    const title = params.title.trim()
    const content = params.content.trim()
    if (!title) throw new Error('Scheduled task title is required')
    if (!content) throw new Error('Scheduled task content is required')

    const authorizedAt = params.authorizeRunAs ? new Date() : null
    const task = await this.scheduledTasks.create({
      tenantId: params.tenantId,
      kind: params.kind ?? 'agent_task',
      title,
      agentId: params.agentId,
      createdById: params.createdById,
      payload: {
        ...(params.payload ?? {}),
        question: content,
        source: 'scheduled_task',
        conversationId: params.conversationId ?? null,
        attachmentDocumentIds: params.attachmentDocumentIds ?? [],
        scheduledRun: true,
      } as Prisma.InputJsonValue,
      runAsUserId: params.authorizeRunAs ? params.createdById : null,
      runAsAuthorizedAt: authorizedAt,
      runAsAuthorizedById: params.authorizeRunAs ? params.createdById : null,
      nextRunAt: params.nextRunAt,
      recurrence: params.recurrence ?? 'none',
      maxRuns: params.maxRuns ?? null,
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.createdById,
      agentVersion: null,
      action: 'scheduled_task.create',
      targetType: 'scheduled_task',
      targetId: task.id,
      modelUsed: null,
      inputRef: params.agentId,
      outputRef: params.nextRunAt.toISOString(),
      policyDecision: 'created',
      metadata: {
        kind: task.kind,
        recurrence: recurrenceLabels[task.recurrence],
        maxRuns: task.maxRuns,
        runAsAuthorized: Boolean(params.authorizeRunAs),
      } as Prisma.JsonValue,
    })

    return task
  }

  async createOneShotAgentTask(
    params: Omit<CreateScheduledAgentTaskParams, 'recurrence' | 'maxRuns'>,
  ): Promise<ScheduledTask> {
    return this.createAgentTask({
      ...params,
      recurrence: 'none',
      maxRuns: null,
    })
  }

  async revoke(params: {
    scheduledTaskId: string
    actorId: string
    tenantId?: string | null
  }): Promise<ScheduledTask> {
    const task = await this.scheduledTasks.findById(params.scheduledTaskId)
    if (!task) throw new Error('Scheduled task not found')
    if (params.tenantId !== undefined && task.tenantId !== params.tenantId) {
      throw new Error('Scheduled task not found')
    }
    if (task.status !== 'active') {
      throw new Error('Only active scheduled tasks can be revoked')
    }

    const revoked = await this.scheduledTasks.revoke(task.id)
    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'scheduled_task.revoke',
      targetType: 'scheduled_task',
      targetId: task.id,
      modelUsed: null,
      inputRef: task.agentId,
      outputRef: revoked.status,
      policyDecision: 'revoked',
      metadata: {
        runAsUserId: task.runAsUserId ?? null,
        nextRunAt: task.nextRunAt.toISOString(),
      } as Prisma.JsonValue,
    })

    return revoked
  }

  async reclaimStaleMaterializations(
    staleAfterMs = Number(process.env.SCHEDULED_TASK_MATERIALIZING_STALE_MS ?? 300_000),
    limit = 10,
  ): Promise<Array<{ scheduledTaskId: string; status: 'reclaimed' | 'skipped' }>> {
    const cutoff = new Date(Date.now() - staleAfterMs)
    const stale = await this.scheduledTasks.findStaleMaterializing(cutoff, limit)
    const results: Array<{ scheduledTaskId: string; status: 'reclaimed' | 'skipped' }> = []

    for (const task of stale) {
      const reclaimed = await this.scheduledTasks.reclaimMaterializing(task.id)
      if (!reclaimed) {
        results.push({ scheduledTaskId: task.id, status: 'skipped' })
        continue
      }

      await this.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'scheduled_task.reclaim',
        targetType: 'scheduled_task',
        targetId: task.id,
        modelUsed: null,
        inputRef: task.agentId,
        outputRef: reclaimed.status,
        policyDecision: 'reclaimed',
        metadata: {
          previousStatus: 'materializing',
          nextRunAt: reclaimed.nextRunAt.toISOString(),
        } as Prisma.JsonValue,
      })

      results.push({ scheduledTaskId: task.id, status: 'reclaimed' })
    }

    return results
  }

  async materializeDue(now = new Date(), limit = 10): Promise<MaterializeResult[]> {
    const due = await this.scheduledTasks.findDue(now, limit)
    const results: MaterializeResult[] = []

    for (const task of due) {
      const claimed = await this.scheduledTasks.claimDue(task.id, now)
      if (!claimed) {
        results.push({ scheduledTaskId: task.id, status: 'skipped' })
        continue
      }

      const basePayload = objectPayload(claimed.payload as Prisma.JsonValue)
      const attachmentDocumentIds = stringArray(basePayload.attachmentDocumentIds)
      const conversationId =
        typeof basePayload.conversationId === 'string' ? basePayload.conversationId : null
      const payload = {
        ...basePayload,
        scheduledTaskId: claimed.id,
        scheduledTaskKind: claimed.kind,
        scheduledRun: true,
        ...scheduledTaskRunAsPayload(claimed),
      }

      const ticket = await this.tickets.create({
        tenantId: claimed.tenantId,
        type: 'interaction',
        title: claimed.title,
        state: 'ready',
        assigneeType: 'agent',
        assigneeId: claimed.agentId,
        agentId: claimed.agentId,
        payload: payload as Prisma.JsonObject,
        sourceDocumentId: attachmentDocumentIds[0] ?? null,
        conversationId,
        executeAfter: null,
        dueBy: null,
        createdById: claimed.createdById,
        source: 'system',
      })

      const nextState = materializedTaskState(claimed, now)
      const materialized = await this.scheduledTasks.markMaterialized(claimed.id, ticket.id, {
        status: nextState.status,
        runCount: nextState.runCount,
        lastRunAt: now,
        materializedAt: now,
        nextRunAt: nextState.nextRunAt,
      })
      if (!materialized) {
        results.push({ scheduledTaskId: claimed.id, status: 'skipped' })
        continue
      }

      await this.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'scheduled_task.materialize',
        targetType: 'scheduled_task',
        targetId: claimed.id,
        modelUsed: null,
        inputRef: claimed.agentId,
        outputRef: ticket.id,
        policyDecision: 'materialized',
        metadata: {
          ticketId: ticket.id,
          runAsUserId: claimed.runAsUserId ?? null,
          recurrence: recurrenceLabels[claimed.recurrence],
          runCount: nextState.runCount,
          nextRunAt: nextState.status === 'active' ? nextState.nextRunAt.toISOString() : null,
        } as Prisma.JsonValue,
      })

      results.push({
        scheduledTaskId: claimed.id,
        status: 'materialized',
        ticketId: ticket.id,
      })
    }

    return results
  }
}

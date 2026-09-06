import type {
  Prisma,
  ScheduledTask,
  ScheduledTaskKind,
  ScheduledTaskRecurrence,
  ScheduledTaskStatus,
} from '@prisma/client'
import type {
  AgentRepository,
  AuditRepository,
  ScheduledTaskRepository,
  TicketRepository,
} from '@/repositories/interfaces'
import { buildRunAsAuthorization } from '@/lib/run-as-payload'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'
import {
  buildTicketScheduleStamp,
  clampIntervalHours,
  occurrenceTitle,
  stampTicketSchedule,
} from '@/lib/ticket-schedule'

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
  intervalHours?: number | null
  maxRuns?: number | null
  authorizeRunAs?: boolean
  conversationId?: string | null
  attachmentDocumentIds?: string[]
  payload?: Record<string, unknown>
  materializedTicketId?: string | null
}

const recurrenceLabels: Record<ScheduledTaskRecurrence, string> = {
  none: 'none',
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
  hourly: 'hourly',
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

export function addRecurrence(
  date: Date,
  recurrence: ScheduledTaskRecurrence,
  intervalHours = 1,
): Date | null {
  if (recurrence === 'none') return null
  const next = new Date(date)
  if (recurrence === 'hourly') {
    next.setUTCHours(next.getUTCHours() + clampIntervalHours(intervalHours))
  }
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

function intervalHoursFromPayload(payload: Prisma.JsonValue): number {
  const hours = objectPayload(payload).intervalHours
  return typeof hours === 'number' ? clampIntervalHours(hours) : 1
}

function seriesTicketIdFrom(payload: Record<string, unknown>, task: ScheduledTask): string | null {
  if (typeof payload.seriesTicketId === 'string' && payload.seriesTicketId) {
    return payload.seriesTicketId
  }
  // Régi board/chat sorozat: az első ticket a sablon, még nincs seriesTicketId.
  if (task.recurrence !== 'none' && task.runCount === 0 && task.materializedTicketId) {
    return task.materializedTicketId
  }
  return null
}

function occurrenceBasePayload(base: Record<string, unknown>): Record<string, unknown> {
      const rest = { ...base }
      delete rest.scheduleSeries
      delete rest.scheduleOccurrence
      delete rest.schedule
      return rest
}

function nextRunAfter(
  scheduledRunAt: Date,
  recurrence: ScheduledTaskRecurrence,
  now: Date,
  intervalHours = 1,
): Date | null {
  let next = addRecurrence(scheduledRunAt, recurrence, intervalHours)
  while (next && next <= now) {
    next = addRecurrence(next, recurrence, intervalHours)
  }
  return next
}

function materializedTaskState(
  task: ScheduledTask,
  now: Date,
): { status: ScheduledTaskStatus; nextRunAt: Date; runCount: number } {
  const runCount = task.runCount + 1
  const nextRunAt = nextRunAfter(
    task.nextRunAt,
    task.recurrence,
    now,
    intervalHoursFromPayload(task.payload as Prisma.JsonValue),
  )
  const maxRunsReached = task.maxRuns !== null && runCount >= task.maxRuns
  if (!nextRunAt || maxRunsReached) {
    return { status: 'materialized', nextRunAt: task.nextRunAt, runCount }
  }
  return { status: 'active', nextRunAt, runCount }
}

export class ScheduledTaskService {
  constructor(
    private scheduledTasks: ScheduledTaskRepository,
    private agents: AgentRepository,
    private audit: AuditRepository,
    private tickets?: TicketRepository,
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
    await this.requireReachableActiveAgent(params.agentId, params.tenantId)

    const authorizedAt = params.authorizeRunAs ? new Date() : null
    const recurrence = params.recurrence ?? 'none'
    const intervalHours =
      recurrence === 'hourly' ? clampIntervalHours(params.intervalHours ?? 1) : undefined
    const schedule = buildTicketScheduleStamp({
      kind: recurrence === 'none' ? 'once' : 'recurring',
      runAt: params.nextRunAt,
      recurrence,
      intervalHours,
      maxRuns: params.maxRuns,
    })
    const task = await this.scheduledTasks.create({
      tenantId: params.tenantId,
      kind: params.kind ?? 'agent_task',
      title,
      agentId: params.agentId,
      createdById: params.createdById,
      payload: stampTicketSchedule(
        {
          ...(params.payload ?? {}),
          question: content,
          source: 'scheduled_task',
          conversationId: params.conversationId ?? null,
          attachmentDocumentIds: params.attachmentDocumentIds ?? [],
        },
        schedule,
      ) as Prisma.InputJsonValue,
      runAsUserId: params.authorizeRunAs ? params.createdById : null,
      runAsAuthorizedAt: authorizedAt,
      runAsAuthorizedById: params.authorizeRunAs ? params.createdById : null,
      nextRunAt: params.nextRunAt,
      recurrence,
      maxRuns: params.maxRuns ?? null,
      materializedTicketId: params.materializedTicketId ?? null,
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
    if (task.status !== 'active' && task.status !== 'materializing' && task.status !== 'materialized') {
      throw new Error('Only scheduled tasks with a revocable run can be revoked')
    }

    const revoked = await this.scheduledTasks.revoke(task.id)
    if (!revoked) throw new Error('Only scheduled tasks with a revocable run can be revoked')
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
      results.push(await this.materializeClaimed(claimed, now))
    }

    return results
  }

  /**
   * Rendkívüli futtatás: most készül egy példány, a naptár szerinti következő
   * időpont nem lép. A claimDue `now` cutoffját a saját nextRunAt-re emeljük,
   * ha a futás még nem esedékes.
   */
  async runNow(params: {
    scheduledTaskId: string
    actorId: string
    tenantId?: string | null
    now?: Date
  }): Promise<Extract<MaterializeResult, { status: 'materialized' }>> {
    const now = params.now ?? new Date()
    const task = await this.scheduledTasks.findById(params.scheduledTaskId)
    if (!task || (params.tenantId !== undefined && task.tenantId !== params.tenantId)) {
      throw new Error('Scheduled task not found')
    }
    if (task.recurrence === 'none') {
      throw new Error('Only recurring scheduled tasks can be run now')
    }
    if (task.status !== 'active') {
      throw new Error('Scheduled task is not active')
    }

    const claimAt = task.nextRunAt > now ? task.nextRunAt : now
    const claimed = await this.scheduledTasks.claimDue(task.id, claimAt)
    if (!claimed) {
      throw new Error('Scheduled task is already running')
    }

    const result = await this.materializeClaimed(claimed, now, {
      actorType: 'human',
      actorId: params.actorId,
    })
    if (result.status !== 'materialized') {
      throw new Error('Failed to start scheduled task')
    }
    return result
  }

  private async materializeClaimed(
    claimed: ScheduledTask,
    now: Date,
    actor: { actorType: 'human' | 'system'; actorId: string | null } = {
      actorType: 'system',
      actorId: null,
    },
  ): Promise<MaterializeResult> {
    const basePayload = objectPayload(claimed.payload as Prisma.JsonValue)
    const attachmentDocumentIds = stringArray(basePayload.attachmentDocumentIds)
    const conversationId =
      typeof basePayload.conversationId === 'string' ? basePayload.conversationId : null
    const extraordinary = actor.actorType === 'human'
    const nextTaskState = extraordinary
      ? { status: 'active' as const, nextRunAt: claimed.nextRunAt, runCount: claimed.runCount }
      : materializedTaskState(claimed, now)
    const occurrenceRunAt = extraordinary ? now : claimed.nextRunAt
    const seriesTicketId = seriesTicketIdFrom(basePayload, claimed)
    const scheduleStamp = buildTicketScheduleStamp({
      kind: claimed.recurrence === 'none' ? 'once' : 'recurring',
      runAt: occurrenceRunAt,
      recurrence: claimed.recurrence,
      intervalHours: intervalHoursFromPayload(claimed.payload as Prisma.JsonValue),
      maxRuns: claimed.maxRuns,
      role: claimed.recurrence === 'none' ? undefined : 'occurrence',
    })
    const payload = stampTicketSchedule(
      {
        ...occurrenceBasePayload(basePayload),
        scheduledTaskKind: claimed.kind,
        ...scheduledTaskRunAsPayload(claimed),
      },
      scheduleStamp,
      {
        scheduledTaskId: claimed.id,
        role: claimed.recurrence === 'none' ? undefined : 'occurrence',
        seriesTicketId,
      },
    )

    // Egyszeri, előre kirakott ticket: ne hozzunk létre másodikat.
    // Rendszeres sorozatnál mindig új példány készül; a sablon a táblán marad.
    if (claimed.recurrence === 'none' && claimed.runCount === 0 && claimed.materializedTicketId) {
      const advanced = await this.scheduledTasks.advanceExistingTicket(claimed.id, {
        ...nextTaskState,
        lastRunAt: now,
        materializedAt: now,
      })
      if (!advanced) {
        return { scheduledTaskId: claimed.id, status: 'skipped' }
      }
      await this.audit.append({
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentVersion: null,
        action: 'scheduled_task.materialize',
        targetType: 'scheduled_task',
        targetId: claimed.id,
        modelUsed: null,
        inputRef: claimed.agentId,
        outputRef: claimed.materializedTicketId,
        policyDecision: 'materialized',
        metadata: {
          ticketId: claimed.materializedTicketId,
          reusedBoardTicket: true,
          runAsUserId: claimed.runAsUserId ?? null,
          recurrence: recurrenceLabels[claimed.recurrence],
          runCount: nextTaskState.runCount,
          nextRunAt: nextTaskState.status === 'active' ? nextTaskState.nextRunAt.toISOString() : null,
          triggeredBy: actor.actorType === 'human' ? 'run_now' : 'due',
        } as Prisma.JsonValue,
      })
      return {
        scheduledTaskId: claimed.id,
        status: 'materialized',
        ticketId: claimed.materializedTicketId,
      }
    }

    const taskPayloadUpdate =
      seriesTicketId && basePayload.seriesTicketId !== seriesTicketId
        ? ({ ...basePayload, seriesTicketId } as Prisma.InputJsonValue)
        : undefined

    const materialized = await this.scheduledTasks.materializeTicket(claimed.id, {
      tenantId: claimed.tenantId,
      type: 'interaction',
      title:
        claimed.recurrence === 'none'
          ? claimed.title
          : occurrenceTitle(claimed.title, occurrenceRunAt),
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
    }, {
      ...nextTaskState,
      lastRunAt: now,
      materializedAt: now,
      ...(taskPayloadUpdate ? { payload: taskPayloadUpdate } : {}),
    })
    if (!materialized) {
      return { scheduledTaskId: claimed.id, status: 'skipped' }
    }
    const ticket = materialized.ticket
    if (!extraordinary) {
      await this.advanceSeriesTicket(claimed, seriesTicketId, nextTaskState)
    }
    await this.audit.append({
      actorType: actor.actorType,
      actorId: actor.actorId,
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
        seriesTicketId,
        runAsUserId: claimed.runAsUserId ?? null,
        recurrence: recurrenceLabels[claimed.recurrence],
        runCount: nextTaskState.runCount,
        nextRunAt: nextTaskState.status === 'active' ? nextTaskState.nextRunAt.toISOString() : null,
        triggeredBy: actor.actorType === 'human' ? 'run_now' : 'due',
      } as Prisma.JsonValue,
    })

    return {
      scheduledTaskId: claimed.id,
      status: 'materialized',
      ticketId: ticket.id,
    }
  }

  /** A sorozat-ticket a következő időpontot mutatja, és soha nem ő a munkapéldány. */
  private async advanceSeriesTicket(
    claimed: ScheduledTask,
    seriesTicketId: string | null,
    nextTaskState: { status: ScheduledTaskStatus; nextRunAt: Date; runCount: number },
  ): Promise<void> {
    if (!this.tickets || !seriesTicketId) return
    const series = await this.tickets.findById(seriesTicketId)
    if (!series) return

    const completed = nextTaskState.status !== 'active'
    const intervalHours = intervalHoursFromPayload(claimed.payload as Prisma.JsonValue)
    const stamp = buildTicketScheduleStamp({
      kind: 'recurring',
      runAt: completed ? claimed.nextRunAt : nextTaskState.nextRunAt,
      recurrence: claimed.recurrence,
      intervalHours,
      maxRuns: claimed.maxRuns,
      role: 'series',
    })
    const payload = stampTicketSchedule(objectPayload(series.payload as Prisma.JsonValue), stamp, {
      scheduledTaskId: claimed.id,
      role: 'series',
    })
    const seriesStillWaiting = series.state === 'ready' || series.state === 'backlog'
    await this.tickets.update(seriesTicketId, {
      executeAfter: completed ? null : nextTaskState.nextRunAt,
      payload: payload as Prisma.JsonObject,
      ...(completed && seriesStillWaiting ? { state: 'done' } : {}),
    })
  }

  /** A tenant a scheduled task életciklusában is domain-szintű határ. */
  private async requireReachableActiveAgent(agentId: string, tenantId: string | null): Promise<void> {
    const agent = await this.agents.findById(agentId)
    if (!agent || agent.status !== 'active' || !isAgentReachableFromTenant(agent.tenantId, tenantId)) {
      // Opak hiba: más tenant agentjének létezése nem szivároghat a scheduler felületén.
      throw new Error('Agent not found')
    }
  }
}

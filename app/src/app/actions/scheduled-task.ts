'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getLocale } from 'next-intl/server'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { describeCron, minimumGapMinutes, parseCron } from '@/domain/scheduled-task/cron'
import { scheduleHash, SCHEDULED_TASK_CLIENT_TYPES } from '@/domain/scheduled-task/stub'
import type { ScheduledTaskPrincipal } from '@/domain/scheduled-task/scheduled-task-service'
import { canOperateAgent } from '@/domain/agent-definition'
import { isAvailableOnMcp } from '@/lib/agent-lifecycle'
import { hasMinimumRole } from '@/lib/iam-policy'
import { prisma } from '@/lib/db'
import { repositories } from '@/repositories/postgres'
import { fail, ok, type ActionResult } from '@/lib/result'

type Kind = 'personal' | 'team' | 'shared'
type MemberState = 'invited' | 'active' | 'needs_reconsent' | 'declined' | 'left'
export type ScheduledTaskInstallationLabel = 'installed' | 'needs_update' | 'locally_disabled'

export type ScheduledTaskRow = {
  taskId: string
  title: string
  instruction: string
  agentId: string
  agentName: string
  kind: Kind
  ownerName: string
  isOwner: boolean
  myState: MemberState | 'owner' | null
  schedule: string
  cron: string
  timezone: string
  status: 'active' | 'paused' | 'archived'
  version: number
  targets: string[]
  ownerSeesResults: boolean
  audience: 'selected' | 'agent_operators'
  runsPerDay: number | null
  /** Célpont-klienstípusonként: van-e élő telepítés („Telepítésre vár”). */
  targetStates: Array<{ clientType: string; installed: boolean }>
  installations: Array<{ clientType: string; userName: string; state: ScheduledTaskInstallationLabel; lastSeenAt: string }>
  multipleInstalls: boolean
  members: Array<{ userId: string; name: string; state: MemberState; installed: boolean }>
  runs: Array<{ runId: string; slot: string; status: string; runnerName: string; catchUp: boolean; summary: string | null; mine: boolean }>
}

type TenantAuthContext = Awaited<ReturnType<typeof requireTenantRole>>

function principalOf(ctx: TenantAuthContext): ScheduledTaskPrincipal {
  return { userId: ctx.user.id, tenantId: ctx.activeTenantId, role: ctx.activeTenantRole, assumed: ctx.assumed }
}

function mapError(error: unknown): ActionResult<never> {
  if (error instanceof TenantAuthError) return fail(error.code)
  if (error instanceof z.ZodError) return fail('invalid_args')
  return fail('unavailable')
}

function runsPerDay(cron: string, timezone: string): number | null {
  const spec = parseCron(cron)
  const gap = spec ? minimumGapMinutes(spec, timezone, new Date()) : null
  return gap !== null && gap < 60 ? Math.round(1440 / gap) : null
}

export async function listScheduledTasksAction(includeArchived = false): Promise<ActionResult<{ tasks: ScheduledTaskRow[]; tenantScope: boolean }>> {
  try {
    const ctx = await requireTenantRole('viewer')
    const principal = principalOf(ctx)
    const tenantScope = hasMinimumRole(ctx.activeTenantRole, 'admin')
    const svc = services.scheduledTasks
    const found = await svc.list(principal, { scope: tenantScope ? 'tenant' : 'mine', includeArchived })
    const userIds = new Set<string>()
    for (const task of found.tasks) userIds.add(task.ownerUserId)
    for (const row of found.members) userIds.add(row.userId)
    for (const row of found.installations) userIds.add(row.userId)
    for (const row of found.runs) userIds.add(row.runnerUserId)
    const [agents, users] = await Promise.all([
      repositories.agents.findMany({ tenantId: ctx.activeTenantId, ids: [...new Set(found.tasks.map((task) => task.agentId))] }),
      repositories.users.findManyByIds([...userIds]),
    ])
    const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]))
    const names = new Map(users.map((user) => [user.id, user.name || user.email]))
    const language = (await getLocale()) === 'en' ? 'en' : 'hu'
    const tasks = found.tasks.map((task): ScheduledTaskRow => {
      const members = found.members.filter((row) => row.taskId === task.id)
      const live = found.installations.filter((row) => row.taskId === task.id && !row.removedAt)
      const isOwner = task.ownerUserId === ctx.user.id
      const mine = members.find((row) => row.userId === ctx.user.id)
      // K13: a mások futásának részleteit (összefoglaló) csak ownerSeesResults mellett látja a tulajdonos.
      const visibleInstalls = isOwner || tenantScope ? live : live.filter((row) => row.userId === ctx.user.id)
      return {
        taskId: task.id,
        title: task.title,
        instruction: task.instruction,
        agentId: task.agentId,
        agentName: agentNames.get(task.agentId) ?? task.agentId,
        kind: task.kind,
        ownerName: names.get(task.ownerUserId) ?? task.ownerUserId,
        isOwner,
        myState: isOwner && !mine ? 'owner' : mine?.state ?? (isOwner ? 'owner' : null),
        schedule: describeCron(task.cron, language),
        cron: task.cron,
        timezone: task.timezone,
        status: task.status,
        version: task.version,
        targets: task.targets,
        ownerSeesResults: task.ownerSeesResults,
        audience: task.audience,
        runsPerDay: runsPerDay(task.cron, task.timezone),
        targetStates: task.targets.map((clientType) => ({ clientType, installed: live.some((row) => row.clientType === clientType && (task.kind === 'personal' ? row.userId === task.ownerUserId : row.userId === ctx.user.id)) })),
        installations: visibleInstalls.map((row) => ({
          clientType: row.clientType,
          userName: names.get(row.userId) ?? row.userId,
          state: row.locallyDisabled ? 'locally_disabled' : row.installedScheduleHash === scheduleHash({ cron: task.cron, timezone: task.timezone, enabled: task.status === 'active' }) ? 'installed' : 'needs_update',
          lastSeenAt: row.lastSeenAt.toISOString(),
        })),
        multipleInstalls: live.filter((row) => task.kind === 'shared' ? row.userId === ctx.user.id : true).length > 1,
        members: isOwner || tenantScope ? members.map((row) => ({ userId: row.userId, name: names.get(row.userId) ?? row.userId, state: row.state, installed: live.some((install) => install.userId === row.userId) })) : [],
        runs: found.runs.filter((run) => run.taskId === task.id).slice(0, 5).map((run) => {
          const view = svc.runView(task, run, ctx.user.id)
          return { runId: run.id, slot: view.slot, status: view.status, runnerName: names.get(run.runnerUserId) ?? run.runnerUserId, catchUp: run.catchUp, summary: 'summary' in view ? view.summary ?? null : null, mine: run.runnerUserId === ctx.user.id }
        }),
      }
    })
    return ok({ tasks, tenantScope })
  } catch (error) {
    return mapError(error)
  }
}

export type ScheduledTaskFormOptions = {
  agents: Array<{ id: string; name: string; userDelegated: boolean; operatorCount: number }>
  members: Array<{ id: string; name: string }>
  canCreateForOthers: boolean
  clientTypes: string[]
}

export async function scheduledTaskFormOptionsAction(): Promise<ActionResult<ScheduledTaskFormOptions>> {
  try {
    const ctx = await requireTenantRole('viewer')
    const [agents, memberships, grants] = await Promise.all([
      repositories.agents.findMany({ tenantId: ctx.activeTenantId, unbounded: true }),
      prisma.tenantMembership.findMany({ where: { tenantId: ctx.activeTenantId, status: 'active' }, include: { user: { select: { id: true, name: true, email: true } } }, take: 500 }),
      repositories.resourceGrants.listAgentGrantsForUser({ tenantId: ctx.activeTenantId, userId: ctx.user.id }),
    ])
    const usable = agents.filter(isAvailableOnMcp).filter((agent) => canOperateAgent({ role: ctx.activeTenantRole, grant: grants.find((grant) => grant.resourceId === agent.id) ?? null, assumed: ctx.assumed }))
    const enriched = await Promise.all(usable.map(async (agent) => {
      // D14: felhasználóhoz kötött hozzáférés (saját Gmail/Drive, privát tudásbázis) → csapat-figyelmeztetés.
      const [bindings, operators] = await Promise.all([
        repositories.agents.findConnectorsForAgent(agent.id),
        repositories.resourceGrants.listAgentGrantsForAgent({ tenantId: ctx.activeTenantId, agentId: agent.id }),
      ])
      const userDelegated = bindings.some(({ connector }) => connector.authMode === 'user_delegated' || connector.visibility === 'private_to_user')
      return { id: agent.id, name: agent.name, userDelegated, operatorCount: operators.filter((grant) => grant.accessLevel === 'operate').length }
    }))
    return ok({
      agents: enriched.sort((a, b) => a.name.localeCompare(b.name)),
      members: memberships.map((row) => ({ id: row.user.id, name: row.user.name || row.user.email })).sort((a, b) => a.name.localeCompare(b.name)),
      canCreateForOthers: hasMinimumRole(ctx.activeTenantRole, 'admin'),
      clientTypes: [...SCHEDULED_TASK_CLIENT_TYPES],
    })
  } catch (error) {
    return mapError(error)
  }
}

const clientTypeSchema = z.enum(SCHEDULED_TASK_CLIENT_TYPES)
const createSchema = z.object({
  agentId: z.string().uuid(),
  kind: z.enum(['personal', 'team', 'shared']),
  title: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(8000),
  cron: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(100),
  targets: z.array(clientTypeSchema).min(1).max(6),
  audience: z.enum(['selected', 'agent_operators']).optional(),
  memberUserIds: z.array(z.string().uuid()).max(200).optional(),
  ownerUserId: z.string().uuid().optional(),
  ownerSeesResults: z.boolean().optional(),
}).strict()

export async function createScheduledTaskAction(input: z.infer<typeof createSchema>): Promise<ActionResult<{ taskId: string }>> {
  try {
    const parsed = createSchema.parse(input)
    const ctx = await requireTenantRole('viewer')
    const result = await services.scheduledTasks.create(principalOf(ctx), parsed)
    if (!result.ok) return fail(result.code)
    revalidatePath('/control-plane/scheduled-tasks')
    return ok({ taskId: result.task.id })
  } catch (error) {
    return mapError(error)
  }
}

const updateSchema = z.object({
  taskId: z.string().uuid(),
  expectedVersion: z.number().int(),
  title: z.string().trim().min(1).max(200).optional(),
  instruction: z.string().trim().min(1).max(8000).optional(),
  cron: z.string().trim().min(1).max(200).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
  targets: z.array(clientTypeSchema).min(1).max(6).optional(),
  ownerSeesResults: z.boolean().optional(),
}).strict()

export async function updateScheduledTaskAction(input: z.infer<typeof updateSchema>): Promise<ActionResult<{ version: number }>> {
  try {
    const parsed = updateSchema.parse(input)
    const ctx = await requireTenantRole('viewer')
    const result = await services.scheduledTasks.update(principalOf(ctx), parsed)
    if (!result.ok) return fail(result.code)
    revalidatePath('/control-plane/scheduled-tasks')
    return ok({ version: result.task.version })
  } catch (error) {
    return mapError(error)
  }
}

const inviteSchema = z.object({ taskId: z.string().uuid(), userIds: z.array(z.string().uuid()).min(1).max(200) }).strict()

export async function inviteScheduledTaskMembersAction(input: z.infer<typeof inviteSchema>): Promise<ActionResult<{ invited: number }>> {
  try {
    const parsed = inviteSchema.parse(input)
    const ctx = await requireTenantRole('viewer')
    const result = await services.scheduledTasks.invite(principalOf(ctx), parsed)
    if (!result.ok) return fail(result.code)
    revalidatePath('/control-plane/scheduled-tasks')
    return ok({ invited: result.invited })
  } catch (error) {
    return mapError(error)
  }
}

const respondSchema = z.object({ taskId: z.string().uuid(), expectedVersion: z.number().int().optional(), response: z.enum(['accept', 'decline']) }).strict()

export async function respondScheduledTaskAction(input: z.infer<typeof respondSchema>): Promise<ActionResult<{ state: string }>> {
  try {
    const parsed = respondSchema.parse(input)
    const ctx = await requireTenantRole('viewer')
    const result = await services.scheduledTasks.respond(principalOf(ctx), parsed)
    if (!result.ok) return fail(result.code)
    revalidatePath('/control-plane/scheduled-tasks')
    return ok({ state: result.state })
  } catch (error) {
    return mapError(error)
  }
}

/** Élő előnézet a létrehozó űrlapnak: hétköznapi leírás + becsült napi futásszám (K6). */
export async function previewScheduleAction(input: { cron: string; timezone: string }): Promise<ActionResult<{ description: string; runsPerDay: number | null; error: string | null }>> {
  try {
    await requireTenantRole('viewer')
    const checked = services.scheduledTasks.validateSchedule(input.cron, input.timezone)
    return ok({
      description: describeCron(input.cron, (await getLocale()) === 'en' ? 'en' : 'hu'),
      runsPerDay: checked.ok ? runsPerDay(checked.cron, checked.timezone) : null,
      error: checked.ok ? null : checked.code,
    })
  } catch (error) {
    return mapError(error)
  }
}

/** K5 idővonal: a futáshoz kötött eszközhívások. K13: a részleteket csak a futtató látja. */
export async function listRunToolCallsAction(runId: string): Promise<ActionResult<{ calls: Array<{ toolName: string; at: string }> }>> {
  try {
    if (!z.string().uuid().safeParse(runId).success) return fail('invalid_args')
    const ctx = await requireTenantRole('viewer')
    const run = await prisma.scheduledTaskRun.findUnique({ where: { id: runId }, include: { task: { select: { tenantId: true } } } })
    if (!run || run.task.tenantId !== ctx.activeTenantId || run.runnerUserId !== ctx.user.id) return fail('not_found')
    const rows = await prisma.auditLog.findMany({
      where: { tenantId: ctx.activeTenantId, action: 'scheduled_task.run_tool_call', metadata: { path: ['scheduledTaskRunId'], equals: runId } },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { createdAt: true, metadata: true },
    })
    return ok({ calls: rows.map((row) => ({ toolName: String((row.metadata as { toolName?: unknown } | null)?.toolName ?? ''), at: row.createdAt.toISOString() })) })
  } catch (error) {
    return mapError(error)
  }
}

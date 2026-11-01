import type { ScheduledTask, ScheduledTaskInstallation, ScheduledTaskMember, ScheduledTaskRun } from '@prisma/client'
import { canOperateAgent } from '@/domain/agent-definition'
import type { AuditSink } from '@/lib/audit/types'
import { isAvailableOnMcp } from '@/lib/agent-lifecycle'
import { hasMinimumRole } from '@/lib/iam-policy'
import { describeCron, isValidTimezone, minimumGapMinutes, nextSlot, normalizeCron, parseCron, prevSlot } from './cron'
import { planScheduledTaskSync, summarizePlan, type InventoryEntry, type PlanAction, type PlanTask, type PlanTaskAccess, type ReportAction } from './sync-plan'
import {
  expectedStubHash, isScheduledTaskClientType, scheduleHash, stubExtraText, stubHash, stubPrompt, syncStubCron, syncStubPrompt,
  type ScheduledTaskClient,
} from './stub'

/**
 * #640: ütemezett feladat — a platform a kanonikus példány, a harness ütemez és futtat.
 * Ez a szolgáltatás csak nyilvántart, foglal és tervez; modellt nem futtat (user-döntés 10-29).
 */

export type TaskRecord = ScheduledTask
export type MemberRecord = ScheduledTaskMember
export type InstallationRecord = ScheduledTaskInstallation
export type RunRecord = ScheduledTaskRun
export type ScheduledTaskPrincipal = { userId: string; tenantId: string; role: string; assumed: boolean }

export type TaskInsert = Pick<TaskRecord, 'tenantId' | 'agentId' | 'ownerUserId' | 'kind' | 'createdById' | 'title' | 'instruction' | 'cron' | 'timezone' | 'graceMinutes' | 'targets' | 'audience' | 'ownerSeesResults' | 'scheduleHash'>
export type TaskPatch = Partial<Pick<TaskRecord, 'title' | 'instruction' | 'cron' | 'timezone' | 'status' | 'targets' | 'scheduleHash' | 'ownerSeesResults'>>
export type MemberInsert = { userId: string; state: MemberRecord['state']; acceptedVersion: number | null; invitedById: string }
export type InstallationUpsert = {
  taskId: string; userId: string; clientType: string; clientInstanceId: string; externalId: string
  installedScheduleHash: string; installedStubHash: string; installedVersion: number; locallyDisabled: boolean; now: Date
}

export interface ScheduledTaskStore {
  countActiveOwned(tenantId: string, userId: string): Promise<number>
  createTask(data: TaskInsert, members: MemberInsert[]): Promise<TaskRecord>
  findTask(tenantId: string, taskId: string): Promise<TaskRecord | null>
  /** userId: tulajdonos vagy tag (bármilyen állapotban). */
  listTasks(input: { tenantId: string; userId?: string; agentId?: string; includeArchived?: boolean; limit: number }): Promise<TaskRecord[]>
  /** K14: „mindenki, aki az agentet használhatja” feladatok ezekre az agentekre. */
  listAudienceTasks(tenantId: string, agentIds: string[]): Promise<TaskRecord[]>
  /** Optimista zár; reconsent: a többi aktív tag `needs_reconsent` (D15), különben az elfogadás követi a verziót. */
  updateTask(input: { tenantId: string; taskId: string; expectedVersion: number; data: TaskPatch; reconsent: boolean; ownerUserId: string }): Promise<TaskRecord | null>
  listMembers(taskIds: string[]): Promise<MemberRecord[]>
  upsertMember(taskId: string, member: MemberInsert): Promise<MemberRecord>
  /** Csak ha még nincs sor (a declined/left tag nem kap újra meghívást). */
  createMemberIfMissing(taskId: string, member: MemberInsert): Promise<void>
  listInstallations(input: { taskIds: string[]; userId?: string; clientType?: string; clientInstanceId?: string }): Promise<InstallationRecord[]>
  upsertInstallation(input: InstallationUpsert): Promise<InstallationRecord>
  markInstallationsRemoved(input: { taskId: string; userId: string; clientType?: string; clientInstanceId?: string; externalId?: string; now: Date }): Promise<number>
  touchInstallations(ids: string[], data: { lastSeenAt: Date; lastSyncAt?: Date }): Promise<void>
  /** null = (taskId, slot, claimKey) már foglalt. */
  insertRun(data: Pick<RunRecord, 'taskId' | 'slot' | 'installationId' | 'runnerUserId' | 'claimKey' | 'taskVersion' | 'definitionVersionId' | 'status' | 'catchUp' | 'ownerSeesResults'>): Promise<RunRecord | null>
  /** K12: az elmaradt (missed) sor pótlásra foglalása. */
  reviveMissedRun(input: { taskId: string; slot: Date; claimKey: string; runnerUserId: string; installationId: string | null; taskVersion: number; definitionVersionId: string | null; ownerSeesResults: boolean }): Promise<RunRecord | null>
  findRun(runId: string): Promise<RunRecord | null>
  findRunsAtSlots(keys: Array<{ taskId: string; slot: Date; claimKey: string }>): Promise<RunRecord[]>
  finishRun(input: { runId: string; runnerUserId: string; status: 'succeeded' | 'failed'; summary: string | null; now: Date }): Promise<RunRecord | null>
  listRuns(input: { taskIds: string[]; limit: number }): Promise<RunRecord[]>
}

export type ScheduledTaskDeps = {
  store: ScheduledTaskStore
  audit: AuditSink
  loadAgent(tenantId: string, agentId: string): Promise<{ id: string; name: string; status: TaskAgentStatus; currentDefinitionVersionId: string | null } | null>
  loadCurrentDefinition(tenantId: string, agentId: string): Promise<{ definitionId: string; contentHash: string } | null>
  findAgentGrant(input: { tenantId: string; userId: string; agentId: string }): Promise<{ accessLevel: string } | null>
  /** K14: kifejezett `operate` grant (az admin implicit hozzáférése nem számít). */
  listOperatorUserIds(tenantId: string, agentId: string): Promise<string[]>
  /** Az agentek, amelyekre a usernek kifejezett `operate` grantja van. */
  listOperableAgentIds(tenantId: string, userId: string): Promise<string[]>
  activeMemberIds(tenantId: string, userIds: string[]): Promise<Set<string>>
  userNames(userIds: string[]): Promise<Map<string, string>>
  /** K5: a futáshoz kötött eszközhívások száma (audit). */
  countLinkedCalls?(input: { tenantId: string; runId: string }): Promise<number>
  now?: () => Date
}
type TaskAgentStatus = Parameters<typeof isAvailableOnMcp>[0]['status']

export type ScheduledTaskCode =
  | 'invalid_args' | 'not_found' | 'not_owner' | 'not_member' | 'not_allowed' | 'conflict' | 'limit_exceeded'
  | 'agent_unavailable' | 'agent_access_denied' | 'schedule_too_frequent' | 'schedule_never_runs'
export type Result<T> = { ok: true } & T | { ok: false; code: ScheduledTaskCode; message?: string; task?: unknown }

const MAX_ACTIVE_OWNED = 50
const MIN_PERIOD_MINUTES = 15
const EARLY_START_MS = 5 * 60_000
const DEFAULT_GRACE_CAP_MINUTES = 120
const RUN_LINK_MAX_AGE_MS = 24 * 3600_000

export type CreateInput = {
  agentId?: unknown; title?: unknown; instruction?: unknown; cron?: unknown; timezone?: unknown; targets?: unknown
  kind?: unknown; audience?: unknown; ownerSeesResults?: unknown; memberUserIds?: unknown; ownerUserId?: unknown
  graceMinutes?: unknown; clientType?: unknown
}
export type UpdateInput = {
  taskId?: unknown; expectedVersion?: unknown
  title?: unknown; instruction?: unknown; cron?: unknown; timezone?: unknown; status?: unknown; targets?: unknown; ownerSeesResults?: unknown
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : null
}

function parseTargets(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 6) return null
  if (!value.every(isScheduledTaskClientType)) return null
  return [...new Set(value as string[])]
}

export function parseClient(value: unknown): ScheduledTaskClient | null {
  if (!value || typeof value !== 'object') return null
  const { clientType, clientInstanceId } = value as Record<string, unknown>
  if (!isScheduledTaskClientType(clientType)) return null
  const instance = str(clientInstanceId, 200)
  return instance ? { clientType, clientInstanceId: instance } : null
}

export class ScheduledTaskService {
  constructor(private deps: ScheduledTaskDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date()
  }

  // ── Validálás ──────────────────────────────────────────────────────────────

  /** K6: érvényes cron, IANA tz, legalább 15 perc két futás között, és egyáltalán fut. */
  validateSchedule(cron: unknown, timezone: unknown): Result<{ cron: string; timezone: string; minGapMinutes: number }> {
    if (typeof cron !== 'string' || !isValidTimezone(timezone)) return { ok: false, code: 'invalid_args' }
    const spec = parseCron(cron)
    if (!spec) return { ok: false, code: 'invalid_args', message: 'cron must have 5 fields: minute hour day-of-month month day-of-week' }
    const gap = minimumGapMinutes(spec, timezone, this.now())
    if (gap === null) return { ok: false, code: 'schedule_never_runs' }
    if (gap < MIN_PERIOD_MINUTES) {
      return { ok: false, code: 'schedule_too_frequent', message: 'A scheduled task runs at most every 15 minutes. Watching for changes more often is monitoring, not a scheduled task.' }
    }
    return { ok: true, cron: normalizeCron(cron), timezone, minGapMinutes: gap }
  }

  // ── Jogosultság ────────────────────────────────────────────────────────────

  private async agentState(principal: ScheduledTaskPrincipal, agentId: string) {
    const [agent, grant] = await Promise.all([
      this.deps.loadAgent(principal.tenantId, agentId),
      this.deps.findAgentGrant({ tenantId: principal.tenantId, userId: principal.userId, agentId }),
    ])
    return {
      agent,
      available: Boolean(agent && isAvailableOnMcp(agent)),
      canOperate: canOperateAgent({ role: principal.role, grant, assumed: principal.assumed }),
    }
  }

  /** Ki futtathatja (D5): egyéni → tulajdonos; csapat/megosztott → elfogadott tag a saját nevében. */
  accessFor(task: TaskRecord, members: MemberRecord[], userId: string): PlanTaskAccess | null {
    const member = members.find((row) => row.taskId === task.id && row.userId === userId)
    if (task.kind === 'personal') {
      if (task.ownerUserId !== userId) return null
      if (!member) return 'ok'
    } else if (!member) return null
    if (member.state === 'invited') return 'needs_consent'
    if (member.state === 'needs_reconsent') return 'needs_reconsent'
    if (member.state === 'declined' || member.state === 'left') return 'not_allowed'
    if (task.kind !== 'personal' && member.acceptedVersion !== task.version) return 'needs_reconsent'
    return 'ok'
  }

  private canView(task: TaskRecord, members: MemberRecord[], principal: ScheduledTaskPrincipal, tenantScope = false) {
    if (task.tenantId !== principal.tenantId) return false
    if (task.ownerUserId === principal.userId) return true
    if (members.some((row) => row.taskId === task.id && row.userId === principal.userId)) return true
    return tenantScope && hasMinimumRole(principal.role as never, 'admin')
  }

  /** K14: az új jogosult meghívást kap (invited sor); a declined/left tag nem. */
  private async inviteAudience(principal: ScheduledTaskPrincipal, agentId?: string) {
    const operable = await this.deps.listOperableAgentIds(principal.tenantId, principal.userId)
    const agentIds = agentId ? operable.filter((id) => id === agentId) : operable
    if (!agentIds.length) return
    const tasks = await this.deps.store.listAudienceTasks(principal.tenantId, agentIds)
    for (const task of tasks) {
      if (task.ownerUserId === principal.userId) continue
      await this.deps.store.createMemberIfMissing(task.id, { userId: principal.userId, state: 'invited', acceptedVersion: null, invitedById: task.ownerUserId })
    }
  }

  // ── Létrehozás / módosítás ────────────────────────────────────────────────

  async create(principal: ScheduledTaskPrincipal, input: CreateInput): Promise<Result<{ task: TaskRecord }>> {
    const agentId = typeof input.agentId === 'string' ? input.agentId : ''
    const title = str(input.title, 200)
    const instruction = str(input.instruction, 8000)
    const kind = input.kind === undefined ? 'personal' : input.kind
    const audience = input.audience === undefined ? 'selected' : input.audience
    if (!title || !instruction || !agentId) return { ok: false, code: 'invalid_args' }
    if (kind !== 'personal' && kind !== 'team' && kind !== 'shared') return { ok: false, code: 'invalid_args' }
    if (audience !== 'selected' && audience !== 'agent_operators') return { ok: false, code: 'invalid_args' }
    if (input.ownerSeesResults !== undefined && typeof input.ownerSeesResults !== 'boolean') return { ok: false, code: 'invalid_args' }
    const schedule = this.validateSchedule(input.cron, input.timezone ?? 'Europe/Budapest')
    if (!schedule.ok) return schedule
    const targets = input.targets === undefined
      ? isScheduledTaskClientType(input.clientType) ? [input.clientType] : null
      : parseTargets(input.targets)
    if (!targets) return { ok: false, code: 'invalid_args', message: 'targets: at least one of claude_routine, claude_desktop, codex, goose, hermes, other' }
    let grace: number | null = null
    if (input.graceMinutes !== undefined && input.graceMinutes !== null) {
      if (typeof input.graceMinutes !== 'number' || !Number.isInteger(input.graceMinutes) || input.graceMinutes < 1 || input.graceMinutes > 1440) return { ok: false, code: 'invalid_args' }
      grace = input.graceMinutes
    }

    // K8: admin másnak is létrehozhat egyéni feladatot — beleegyezéssel (invited).
    const ownerUserId = input.ownerUserId === undefined || input.ownerUserId === principal.userId ? principal.userId : input.ownerUserId
    if (typeof ownerUserId !== 'string') return { ok: false, code: 'invalid_args' }
    if (ownerUserId !== principal.userId && (kind !== 'personal' || !hasMinimumRole(principal.role as never, 'admin'))) return { ok: false, code: 'not_allowed' }
    const memberIds = input.memberUserIds === undefined ? [] : input.memberUserIds
    if (!Array.isArray(memberIds) || memberIds.length > 200 || !memberIds.every((id) => typeof id === 'string')) return { ok: false, code: 'invalid_args' }
    if (kind === 'personal' && memberIds.length) return { ok: false, code: 'invalid_args' }

    const state = await this.agentState(principal, agentId)
    if (!state.agent || !state.available) return { ok: false, code: 'agent_unavailable' }
    if (!state.canOperate) return { ok: false, code: 'agent_access_denied' }
    const wanted = [...new Set([ownerUserId, ...(memberIds as string[])])]
    const active = await this.deps.activeMemberIds(principal.tenantId, wanted)
    if (wanted.some((id) => !active.has(id))) return { ok: false, code: 'invalid_args', message: 'every member must be an active member of this organization' }
    if (await this.deps.store.countActiveOwned(principal.tenantId, ownerUserId) >= MAX_ACTIVE_OWNED) return { ok: false, code: 'limit_exceeded' }

    const members: MemberInsert[] = []
    if (kind === 'personal') {
      if (ownerUserId !== principal.userId) members.push({ userId: ownerUserId, state: 'invited', acceptedVersion: null, invitedById: principal.userId })
    } else {
      members.push({ userId: ownerUserId, state: 'active', acceptedVersion: 1, invitedById: principal.userId })
      for (const id of memberIds as string[]) if (id !== ownerUserId) members.push({ userId: id, state: 'invited', acceptedVersion: null, invitedById: principal.userId })
    }
    const task = await this.deps.store.createTask({
      tenantId: principal.tenantId, agentId, ownerUserId, kind, createdById: principal.userId, title, instruction,
      cron: schedule.cron, timezone: schedule.timezone, graceMinutes: grace, targets, audience,
      ownerSeesResults: input.ownerSeesResults === true,
      scheduleHash: scheduleHash({ cron: schedule.cron, timezone: schedule.timezone, enabled: true }),
    }, members)
    await this.record('scheduled_task.create', principal, task, { kind, targets, cron: task.cron, timezone: task.timezone, members: members.length })
    return { ok: true, task }
  }

  async update(principal: ScheduledTaskPrincipal, input: UpdateInput): Promise<Result<{ task: TaskRecord }>> {
    const task = typeof input.taskId === 'string' ? await this.deps.store.findTask(principal.tenantId, input.taskId) : null
    if (!task || task.status === 'archived' && input.status !== 'archived') return { ok: false, code: 'not_found' }
    if (task.ownerUserId !== principal.userId) return { ok: false, code: 'not_owner' }
    if (typeof input.expectedVersion !== 'number' || !Number.isInteger(input.expectedVersion)) return { ok: false, code: 'invalid_args' }
    if (input.expectedVersion !== task.version) return { ok: false, code: 'conflict', task: this.view(task) }
    const data: TaskPatch = {}
    if (input.title !== undefined) {
      const title = str(input.title, 200)
      if (!title) return { ok: false, code: 'invalid_args' }
      data.title = title
    }
    if (input.instruction !== undefined) {
      const instruction = str(input.instruction, 8000)
      if (!instruction) return { ok: false, code: 'invalid_args' }
      if (instruction !== task.instruction) data.instruction = instruction
    }
    if (input.cron !== undefined || input.timezone !== undefined) {
      const schedule = this.validateSchedule(input.cron ?? task.cron, input.timezone ?? task.timezone)
      if (!schedule.ok) return schedule
      data.cron = schedule.cron
      data.timezone = schedule.timezone
    }
    if (input.status !== undefined) {
      if (input.status !== 'active' && input.status !== 'paused' && input.status !== 'archived') return { ok: false, code: 'invalid_args' }
      data.status = input.status
    }
    if (input.targets !== undefined) {
      const targets = parseTargets(input.targets)
      if (!targets) return { ok: false, code: 'invalid_args' }
      data.targets = targets
    }
    if (input.ownerSeesResults !== undefined) {
      if (typeof input.ownerSeesResults !== 'boolean') return { ok: false, code: 'invalid_args' }
      data.ownerSeesResults = input.ownerSeesResults
    }
    const next = { ...task, ...data }
    data.scheduleHash = scheduleHash({ cron: next.cron, timezone: next.timezone, enabled: next.status === 'active' })
    // D15: utasítás-változás vagy az eredmény-láthatóság bekapcsolása → új beleegyezés; ütemezéshez nem kell.
    const reconsent = task.kind !== 'personal' && (data.instruction !== undefined || (data.ownerSeesResults === true && !task.ownerSeesResults))
    const updated = await this.deps.store.updateTask({ tenantId: principal.tenantId, taskId: task.id, expectedVersion: task.version, data, reconsent, ownerUserId: task.ownerUserId })
    if (!updated) {
      const fresh = await this.deps.store.findTask(principal.tenantId, task.id)
      return { ok: false, code: 'conflict', task: fresh ? this.view(fresh) : undefined }
    }
    await this.record('scheduled_task.update', principal, updated, { fields: Object.keys(data).filter((key) => key !== 'scheduleHash'), reconsent, version: updated.version })
    return { ok: true, task: updated }
  }

  /** Csapat-/megosztott feladatba új tagok meghívása (csak a tulajdonos). */
  async invite(principal: ScheduledTaskPrincipal, input: { taskId: string; userIds: string[] }): Promise<Result<{ invited: number }>> {
    const task = await this.deps.store.findTask(principal.tenantId, input.taskId)
    if (!task || task.status === 'archived') return { ok: false, code: 'not_found' }
    if (task.ownerUserId !== principal.userId) return { ok: false, code: 'not_owner' }
    if (task.kind === 'personal' || input.userIds.length > 200) return { ok: false, code: 'invalid_args' }
    const active = await this.deps.activeMemberIds(principal.tenantId, input.userIds)
    if (input.userIds.some((id) => !active.has(id))) return { ok: false, code: 'invalid_args' }
    const existing = await this.deps.store.listMembers([task.id])
    let invited = 0
    for (const userId of input.userIds) {
      const row = existing.find((member) => member.userId === userId)
      if (row && (row.state === 'active' || row.state === 'invited' || row.state === 'needs_reconsent')) continue
      // A tulajdonos kifejezett újrameghívása a declined/left tagot is visszahívja (K14).
      await this.deps.store.upsertMember(task.id, { userId, state: 'invited', acceptedVersion: null, invitedById: principal.userId })
      invited += 1
    }
    await this.record('scheduled_task.invite', principal, task, { invited })
    return { ok: true, invited }
  }

  /** Elutasítás / kilépés (D6, K8); a kilépés a telepítéseit is eltávolítja. */
  async respond(principal: ScheduledTaskPrincipal, input: { taskId: string; response: 'decline' | 'accept'; expectedVersion?: number }): Promise<Result<{ state: MemberRecord['state'] }>> {
    const task = await this.deps.store.findTask(principal.tenantId, input.taskId)
    if (!task) return { ok: false, code: 'not_found' }
    const members = await this.deps.store.listMembers([task.id])
    const member = members.find((row) => row.userId === principal.userId)
    if (!member) return { ok: false, code: task.ownerUserId === principal.userId ? 'invalid_args' : 'not_found' }
    if (input.response === 'accept') {
      if (input.expectedVersion !== task.version) return { ok: false, code: 'conflict' }
      if (member.state !== 'needs_reconsent' && !(member.state === 'active' && member.acceptedVersion !== task.version)) return { ok: false, code: 'invalid_args' }
      await this.deps.store.upsertMember(task.id, { userId: principal.userId, state: 'active', acceptedVersion: task.version, invitedById: member.invitedById })
      await this.record('scheduled_task.accept', principal, task, { version: task.version })
      return { ok: true, state: 'active' }
    }
    if (task.kind !== 'personal' && task.ownerUserId === principal.userId) return { ok: false, code: 'not_allowed', message: 'The owner cannot leave; archive the task or hand it over.' }
    const state = member.state === 'invited' ? 'declined' : 'left'
    await this.deps.store.upsertMember(task.id, { userId: principal.userId, state, acceptedVersion: member.acceptedVersion, invitedById: member.invitedById })
    await this.deps.store.markInstallationsRemoved({ taskId: task.id, userId: principal.userId, now: this.now() })
    await this.record(state === 'declined' ? 'scheduled_task.decline' : 'scheduled_task.leave', principal, task, {})
    return { ok: true, state }
  }

  // ── Olvasás ────────────────────────────────────────────────────────────────

  async list(principal: ScheduledTaskPrincipal, input: { agentId?: string; scope?: 'mine' | 'tenant'; includeArchived?: boolean } = {}) {
    const tenantScope = input.scope === 'tenant' && hasMinimumRole(principal.role as never, 'admin')
    await this.inviteAudience(principal, input.agentId).catch(() => undefined)
    const tasks = await this.deps.store.listTasks({ tenantId: principal.tenantId, userId: tenantScope ? undefined : principal.userId, agentId: input.agentId, includeArchived: input.includeArchived, limit: 200 })
    const ids = tasks.map((task) => task.id)
    const [members, installations, runs] = await Promise.all([
      this.deps.store.listMembers(ids),
      this.deps.store.listInstallations({ taskIds: ids }),
      this.deps.store.listRuns({ taskIds: ids, limit: 10 * Math.max(ids.length, 1) }),
    ])
    return { tasks, members, installations, runs }
  }

  async get(principal: ScheduledTaskPrincipal, taskId: string, tenantScope = false): Promise<Result<{ task: TaskRecord; members: MemberRecord[]; installations: InstallationRecord[]; runs: RunRecord[] }>> {
    const task = await this.deps.store.findTask(principal.tenantId, taskId)
    if (!task) return { ok: false, code: 'not_found' }
    const members = await this.deps.store.listMembers([task.id])
    if (!this.canView(task, members, principal, tenantScope)) return { ok: false, code: 'not_found' }
    const [installations, runs] = await Promise.all([
      this.deps.store.listInstallations({ taskIds: [task.id] }),
      this.deps.store.listRuns({ taskIds: [task.id], limit: 20 }),
    ])
    return { ok: true, task, members, installations, runs }
  }

  /** A hívónak szóló nézet; a mások futás-összefoglalóját csak `ownerSeesResults` mellett látja a tulajdonos (K13). */
  view(task: TaskRecord, extra?: { members?: MemberRecord[]; installations?: InstallationRecord[]; runs?: RunRecord[]; viewerUserId?: string; client?: ScheduledTaskClient | null; language?: 'hu' | 'en' }) {
    const viewer = extra?.viewerUserId
    const lastRun = extra?.runs?.filter((run) => run.taskId === task.id).sort((a, b) => b.slot.getTime() - a.slot.getTime())[0]
    return {
      taskId: task.id,
      title: task.title,
      agentId: task.agentId,
      kind: task.kind,
      instruction: task.instruction,
      cron: task.cron,
      timezone: task.timezone,
      schedule: describeCron(task.cron, extra?.language ?? 'en'),
      status: task.status,
      version: task.version,
      targets: task.targets,
      ownerUserId: task.ownerUserId,
      ownerSeesResults: task.ownerSeesResults,
      scheduleHash: task.scheduleHash,
      ...(extra?.client ? { stubHash: expectedStubHash(task.id, extra.client) } : {}),
      ...(extra?.installations ? {
        installations: extra.installations.filter((row) => row.taskId === task.id && !row.removedAt && (!viewer || row.userId === viewer || task.ownerUserId === viewer)).map((row) => ({
          clientType: row.clientType,
          clientInstanceId: row.clientInstanceId,
          externalId: row.externalId,
          state: row.locallyDisabled ? 'locally_disabled' : row.installedScheduleHash === task.scheduleHash ? 'installed' : 'needs_update',
          lastSeenAt: row.lastSeenAt.toISOString(),
        })),
      } : {}),
      ...(lastRun ? { lastRun: this.runView(task, lastRun, viewer) } : {}),
    }
  }

  runView(task: TaskRecord, run: RunRecord, viewerUserId?: string) {
    const seesSummary = !viewerUserId || run.runnerUserId === viewerUserId || (task.ownerSeesResults && run.ownerSeesResults && task.ownerUserId === viewerUserId)
    return {
      runId: run.id,
      slot: run.slot.toISOString(),
      status: run.status === 'running' && this.now().getTime() - run.startedAt.getTime() > RUN_LINK_MAX_AGE_MS ? 'not_reported' : run.status,
      runnerUserId: run.runnerUserId,
      catchUp: run.catchUp,
      ...(seesSummary && run.summary ? { summary: run.summary } : {}),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    }
  }

  /** §4.7 telepítési recept: a csonk + ütemezés + kliensenkénti lépések. */
  recipe(task: Pick<TaskRecord, 'id' | 'title' | 'cron' | 'timezone' | 'status'>, client: ScheduledTaskClient, enabled = task.status === 'active') {
    const prompt = stubPrompt({ taskId: task.id, client })
    return {
      taskId: task.id,
      name: `Excellence: ${task.title}`.slice(0, 120),
      stubPrompt: prompt,
      stubHash: stubHash(prompt),
      cron: task.cron,
      timezone: task.timezone,
      enabled,
      scheduleHash: scheduleHash({ cron: task.cron, timezone: task.timezone, enabled }),
      steps: clientSteps(client.clientType),
    }
  }

  // ── Szinkron (§4.6, §5) ───────────────────────────────────────────────────

  private async planTasks(principal: ScheduledTaskPrincipal, agentId?: string) {
    await this.inviteAudience(principal, agentId).catch(() => undefined)
    const tasks = await this.deps.store.listTasks({ tenantId: principal.tenantId, userId: principal.userId, agentId, includeArchived: true, limit: 200 })
    const ids = tasks.map((task) => task.id)
    const [members, allInstallations] = await Promise.all([
      this.deps.store.listMembers(ids),
      this.deps.store.listInstallations({ taskIds: ids }),
    ])
    const agentIds = [...new Set(tasks.map((task) => task.agentId))]
    const operate = new Map<string, boolean>()
    await Promise.all(agentIds.map(async (id) => operate.set(id, (await this.agentState(principal, id)).canOperate)))
    const names = await this.deps.userNames([...new Set([...tasks.map((task) => task.ownerUserId), ...members.map((row) => row.invitedById)])])
    const planTasks: PlanTask[] = []
    for (const task of tasks) {
      let access = this.accessFor(task, members, principal.userId)
      if (access === null) continue
      if (!operate.get(task.agentId)) access = 'not_allowed'
      const live = allInstallations.filter((row) => row.taskId === task.id && !row.removedAt)
      if (task.status === 'archived' && !live.some((row) => row.userId === principal.userId)) continue
      const member = members.find((row) => row.taskId === task.id && row.userId === principal.userId)
      planTasks.push({
        taskId: task.id, title: task.title, kind: task.kind, ownerSeesResults: task.ownerSeesResults, status: task.status, cron: task.cron, timezone: task.timezone,
        targets: task.targets, version: task.version, instruction: task.instruction,
        isOwner: task.ownerUserId === principal.userId,
        ownerName: names.get(task.ownerUserId) ?? 'the owner',
        inviterName: member ? names.get(member.invitedById) ?? null : null,
        access,
        liveInstallations: live.length,
        memberCount: members.filter((row) => row.taskId === task.id && row.state === 'active' && row.userId !== task.ownerUserId).length,
      })
    }
    return { tasks, planTasks, members, allInstallations }
  }

  async sync(principal: ScheduledTaskPrincipal, input: { client?: unknown; agentId?: unknown; inventory?: unknown; unattended?: unknown }) {
    const client = parseClient(input.client)
    if (!client) return { ok: false as const, code: 'invalid_args' as const, message: 'client: { clientType, clientInstanceId }' }
    const agentId = typeof input.agentId === 'string' ? input.agentId : undefined
    const rawInventory = input.inventory === undefined ? [] : input.inventory
    if (!Array.isArray(rawInventory) || rawInventory.length > 200) return { ok: false as const, code: 'invalid_args' as const }
    const inventory: InventoryEntry[] = []
    for (const raw of rawInventory) {
      if (!raw || typeof raw !== 'object') return { ok: false as const, code: 'invalid_args' as const }
      const entry = raw as Record<string, unknown>
      const taskId = str(entry.taskId, 64)
      const externalId = str(entry.externalId, 200)
      if (!taskId || !externalId || typeof entry.cron !== 'string' || typeof entry.timezone !== 'string' || typeof entry.enabled !== 'boolean') return { ok: false as const, code: 'invalid_args' as const }
      // A modell nem tud hash-t számolni: a csonk szövegét (≤ 2000) küldi, a hash-t a szerver számolja.
      const text = typeof entry.stubText === 'string' ? entry.stubText.slice(0, 2000) : null
      const hash = text !== null ? stubHash(text) : typeof entry.stubHash === 'string' ? entry.stubHash : null
      if (!hash) return { ok: false as const, code: 'invalid_args' as const, message: 'each inventory entry needs stubText (or stubHash)' }
      const extraText = text !== null && hash !== expectedStubHash(taskId, client) ? stubExtraText(text, taskId, client) : ''
      inventory.push({ taskId, externalId, cron: entry.cron.slice(0, 200), timezone: entry.timezone.slice(0, 100), enabled: entry.enabled, stubHash: hash, ...(extraText ? { extraText: extraText.slice(0, 2000) } : {}) })
    }
    const { tasks, planTasks, allInstallations } = await this.planTasks(principal, agentId)
    const mine = allInstallations.filter((row) => row.userId === principal.userId && row.clientType === client.clientType && row.clientInstanceId === client.clientInstanceId && !row.removedAt)
    const actions = planScheduledTaskSync({
      client,
      tasks: planTasks,
      installations: mine.map((row) => ({ taskId: row.taskId, externalId: row.externalId, installedScheduleHash: row.installedScheduleHash, locallyDisabled: row.locallyDisabled })),
      inventory,
    })
    const now = this.now()
    const seen = mine.filter((row) => inventory.some((entry) => entry.taskId === row.taskId && entry.externalId === row.externalId)).map((row) => row.id)
    if (seen.length) await this.deps.store.touchInstallations(seen, { lastSeenAt: now, lastSyncAt: now })
    const recipeTasks = new Set(actions.filter((action) => action.op !== 'remove' && action.op !== 'report').map((action) => action.taskId))
    const recipes = tasks.filter((task) => recipeTasks.has(task.id)).map((task) => this.recipe(task, client))
    const unattended = input.unattended === true
    const hasLive = mine.length > 0 || actions.some((action) => action.op === 'install')
    return {
      ok: true as const,
      syncRevision: this.revision(planTasks),
      summary: summarizePlan(actions),
      actions: unattended ? actions.map((action) => (action.op === 'ask' ? { ...action, deferred: true } : action)) : actions,
      recipes,
      guidance: unattended
        ? 'Unattended: carry out only actions whose op is not "ask"; leave questions for the next interactive session. Then call platform.scheduled_task.install_report with every report step.'
        : 'Carry out each action: for op "ask", ask the user the message and run the steps of the chosen option. Use recipes[] for local install/update. Finish with one platform.scheduled_task.install_report carrying every report step (add externalId for new installs). Never edit a platform stub by hand.',
      ...(hasLive && supportsSyncStub(client.clientType) ? {
        syncStub: { name: 'Excellence: scheduled task sync', prompt: syncStubPrompt(client), cron: syncStubCron(principal.userId), timezone: 'Europe/Budapest', note: 'Install once per client, next to the first task. It has no catch-up window: if it was missed, run it at the next wake-up.' },
      } : {}),
    }
  }

  private revision(tasks: PlanTask[]) {
    return stubHash(JSON.stringify(tasks.map((task) => [task.taskId, task.version, task.status, task.access]).sort()))
  }

  async installReport(principal: ScheduledTaskPrincipal, input: { client?: unknown; reports?: unknown }) {
    const client = parseClient(input.client)
    if (!client || !Array.isArray(input.reports) || input.reports.length === 0 || input.reports.length > 100) return { ok: false as const, code: 'invalid_args' as const }
    const now = this.now()
    const results: Array<{ taskId: string; action: string; ok: boolean; code?: string }> = []
    for (const raw of input.reports) {
      const report = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const taskId = typeof report.taskId === 'string' ? report.taskId : ''
      const action = report.action as ReportAction
      const outcome = await this.applyReport(principal, client, taskId, action, report, now)
      results.push({ taskId, action: String(action), ...outcome })
    }
    return { ok: true as const, results }
  }

  private async applyReport(principal: ScheduledTaskPrincipal, client: ScheduledTaskClient, taskId: string, action: ReportAction, report: Record<string, unknown>, now: Date): Promise<{ ok: boolean; code?: string }> {
    if (!['installed', 'updated', 'removed', 'disabled', 'accepted', 'declined'].includes(action)) return { ok: false, code: 'invalid_args' }
    const task = taskId ? await this.deps.store.findTask(principal.tenantId, taskId) : null
    if (!task) return { ok: false, code: 'not_found' }
    const members = await this.deps.store.listMembers([task.id])
    const access = this.accessFor(task, members, principal.userId)
    if (access === null) return { ok: false, code: 'not_found' }
    const externalId = typeof report.externalId === 'string' ? report.externalId.trim().slice(0, 200) : ''
    if (action === 'accepted' || action === 'declined') {
      const outcome = await this.respond(principal, { taskId: task.id, response: action === 'accepted' ? 'accept' : 'decline', expectedVersion: report.expectedVersion as number | undefined })
      return outcome.ok ? { ok: true } : { ok: false, code: outcome.code }
    }
    if (action === 'removed') {
      await this.deps.store.markInstallationsRemoved({ taskId: task.id, userId: principal.userId, clientType: client.clientType, clientInstanceId: client.clientInstanceId, externalId: externalId || undefined, now })
      await this.record('scheduled_task.install_report', principal, task, { action, clientType: client.clientType })
      return { ok: true }
    }
    if (access === 'not_allowed') return { ok: false, code: 'not_allowed' }
    if (task.status === 'archived') return { ok: false, code: 'not_found' }
    if (!task.targets.includes(client.clientType)) return { ok: false, code: 'not_allowed' }
    const hash = typeof report.scheduleHash === 'string' ? report.scheduleHash.slice(0, 64) : ''
    const stub = typeof report.stubHash === 'string' ? report.stubHash.slice(0, 64) : ''
    if (!externalId || !hash || !stub) return { ok: false, code: 'invalid_args' }
    if (access === 'needs_consent' && report.expectedVersion !== task.version) return { ok: false, code: 'conflict' }
    // Egy (task, user, kliens) egy élő telepítés: a régi externalId-k lezárulnak (L7 újratelepítés).
    await this.deps.store.markInstallationsRemoved({ taskId: task.id, userId: principal.userId, clientType: client.clientType, clientInstanceId: client.clientInstanceId, now })
    await this.deps.store.upsertInstallation({
      taskId: task.id, userId: principal.userId, clientType: client.clientType, clientInstanceId: client.clientInstanceId, externalId,
      installedScheduleHash: hash, installedStubHash: stub, installedVersion: task.version,
      locallyDisabled: report.locallyDisabled === true, now,
    })
    // D6: a telepítés a beleegyezés.
    if (action === 'installed' && access === 'needs_consent') {
      const member = members.find((row) => row.userId === principal.userId)!
      await this.deps.store.upsertMember(task.id, { userId: principal.userId, state: 'active', acceptedVersion: task.version, invitedById: member.invitedById })
      await this.record('scheduled_task.accept', principal, task, { version: task.version, via: 'install' })
    }
    await this.record('scheduled_task.install_report', principal, task, { action, clientType: client.clientType, locallyDisabled: report.locallyDisabled === true })
    return { ok: true }
  }

  // ── Futás (§4.4, §4.5) ────────────────────────────────────────────────────

  private grace(task: TaskRecord, slot: Date, spec: NonNullable<ReturnType<typeof parseCron>>) {
    if (task.graceMinutes) return task.graceMinutes
    const next = nextSlot(spec, task.timezone, slot)
    const period = next ? (next.getTime() - slot.getTime()) / 60_000 : DEFAULT_GRACE_CAP_MINUTES
    return Math.min(period, DEFAULT_GRACE_CAP_MINUTES)
  }

  /** §4.4 lépés 3: korai indulásnál (≤ 5 perc) a következő slot; különben a legutóbbi. */
  slotFor(task: TaskRecord, now: Date): { slot: Date; graceMinutes: number } | null {
    const spec = parseCron(task.cron)
    if (!spec) return null
    const next = nextSlot(spec, task.timezone, now)
    const slot = next && next.getTime() - now.getTime() <= EARLY_START_MS ? next : prevSlot(spec, task.timezone, now)
    if (!slot) return null
    return { slot, graceMinutes: this.grace(task, slot, spec) }
  }

  async runStart(principal: ScheduledTaskPrincipal, input: { taskId?: unknown; installation?: unknown; scheduleHash?: unknown; stubHash?: unknown; catchUp?: unknown }) {
    const stop = (outcome: 'skip' | 'deny', code: string, message: string, extra: Record<string, unknown> = {}) =>
      ({ ok: false as const, outcome, code, message: `Do nothing and exit: ${message}`, ...extra })
    const task = typeof input.taskId === 'string' ? await this.deps.store.findTask(principal.tenantId, input.taskId) : null
    if (!task) return stop('deny', 'not_found', 'this scheduled task does not exist.', { steps: [{ type: 'local', op: 'remove' }] })
    const members = await this.deps.store.listMembers([task.id])
    const access = this.accessFor(task, members, principal.userId)
    if (access === null) return stop('deny', task.kind === 'personal' ? 'not_owner' : 'not_member', 'this task does not run in your name.', { steps: [{ type: 'local', op: 'remove' }] })
    if (task.status === 'archived') return stop('deny', 'archived', 'the task was archived.', { steps: [{ type: 'local', op: 'remove' }] })
    if (task.status === 'paused') return stop('deny', 'paused', 'the task is paused.', { steps: [{ type: 'local', op: 'disable' }] })
    if (access === 'not_allowed') return stop('deny', 'not_member', 'you left or declined this task.', { steps: [{ type: 'local', op: 'remove' }] })
    if (access === 'needs_consent') return stop('skip', 'needs_consent', 'the task is waiting for your consent in the next interactive session.')
    if (access === 'needs_reconsent') return stop('skip', 'needs_reconsent', 'the task changed and waits for your acceptance in the next interactive session.')
    const agent = await this.agentState(principal, task.agentId)
    if (!agent.available) return stop('deny', 'agent_unavailable', 'the agent is no longer published.')
    if (!agent.canOperate) return stop('deny', 'agent_access_revoked', 'you can no longer use this agent.', { steps: [{ type: 'local', op: 'remove' }] })

    const now = this.now()
    const computed = this.slotFor(task, now)
    if (!computed || computed.slot.getTime() < task.createdAt.getTime() - EARLY_START_MS) return stop('skip', 'not_due', 'no scheduled time is due yet.')
    const { slot, graceMinutes } = computed
    const claimKey = task.kind === 'shared' ? principal.userId : ''
    const client = parseClient(input.installation)
    if (client && !task.targets.includes(client.clientType)) return stop('deny', 'target_not_allowed', 'this client is no longer a target.', { steps: [{ type: 'local', op: 'remove' }] })
    const externalId = input.installation && typeof (input.installation as Record<string, unknown>).externalId === 'string'
      ? String((input.installation as Record<string, unknown>).externalId).slice(0, 200) : ''
    const installation = client ? await this.findOrRegisterInstallation(principal, task, client, externalId, now) : null
    const definition = await this.deps.loadCurrentDefinition(principal.tenantId, task.agentId)
    if (!definition) return stop('deny', 'agent_unavailable', 'the agent is no longer published.')
    const late = now.getTime() - slot.getTime() > graceMinutes * 60_000
    // K12: a pótlás csak a türelmi időn túli (elmaradt) legutolsó alkalomra értelmes.
    const catchUp = input.catchUp === true && late
    const runData = { taskId: task.id, slot, claimKey, runnerUserId: principal.userId, installationId: installation?.id ?? null, taskVersion: task.version, definitionVersionId: definition.definitionId, ownerSeesResults: task.ownerSeesResults }
    let run: RunRecord | null
    if (late && !catchUp) {
      await this.deps.store.insertRun({ ...runData, status: 'missed', catchUp: false })
      return stop('skip', 'missed', `the scheduled time ${slot.toISOString()} is past its ${graceMinutes}-minute window.`)
    }
    if (catchUp) {
      // K12: csak interaktívan, a user kérésére, csak a legutolsó elmaradt alkalomra.
      run = (await this.deps.store.reviveMissedRun(runData)) ?? (await this.deps.store.insertRun({ ...runData, status: 'running', catchUp: true }))
    } else {
      run = await this.deps.store.insertRun({ ...runData, status: 'running', catchUp: false })
    }
    if (!run) return stop('skip', 'already_claimed', 'this scheduled time already ran (or is running) elsewhere.')
    await this.record('scheduled_task.run_start', principal, task, { runId: run.id, slot: slot.toISOString(), catchUp, clientType: client?.clientType ?? null })
    return {
      ok: true as const,
      runId: run.id,
      slot: slot.toISOString(),
      title: task.title,
      instruction: task.instruction,
      agentId: task.agentId,
      definitionId: definition.definitionId,
      contentHash: definition.contentHash,
      policyHints: {
        unattended: true,
        approvals: 'Writes that need approval stay pending; do not wait for them. Mention in the summary how many are waiting.',
      },
      guidance: `Work as this agent: call platform.agent.get_definition { "agentId": "${task.agentId}" } if its rules are not loaded. Pass scheduledRunId "${run.id}" together with definitionId on every enterprise tool call. When done, call platform.scheduled_task.run_finish with runId, status and a short summary (at most 2000 characters).`,
      ...(installation && client ? { drift: this.drift(task, installation, client, input) } : {}),
    }
  }

  private async findOrRegisterInstallation(principal: ScheduledTaskPrincipal, task: TaskRecord, client: ScheduledTaskClient, externalId: string, now: Date) {
    const rows = await this.deps.store.listInstallations({ taskIds: [task.id], userId: principal.userId, clientType: client.clientType, clientInstanceId: client.clientInstanceId })
    const live = rows.filter((row) => !row.removedAt)
    const found = (externalId ? live.find((row) => row.externalId === externalId) : undefined) ?? live[0]
    if (found) {
      await this.deps.store.touchInstallations([found.id], { lastSeenAt: now })
      return found
    }
    if (!externalId) return null
    // Futásból ismert meg egy telepítést: az alapja ismeretlen, a következő szinkron rendezi.
    return this.deps.store.upsertInstallation({
      taskId: task.id, userId: principal.userId, clientType: client.clientType, clientInstanceId: client.clientInstanceId, externalId,
      installedScheduleHash: '', installedStubHash: '', installedVersion: task.version, locallyDisabled: false, now,
    })
  }

  /** S2: a futás saját drift-ellenőrzése — a futás végén alkalmazandó. Jogkört nem bővít (§8). */
  private drift(task: TaskRecord, installation: InstallationRecord, client: ScheduledTaskClient, input: { scheduleHash?: unknown; stubHash?: unknown }) {
    const desired = scheduleHash({ cron: task.cron, timezone: task.timezone, enabled: task.status === 'active' && !installation.locallyDisabled })
    const localHash = typeof input.scheduleHash === 'string' ? input.scheduleHash : null
    const localStub = typeof input.stubHash === 'string' ? input.stubHash : null
    if ((localHash && localHash !== installation.installedScheduleHash) || (localStub && localStub !== expectedStubHash(task.id, client)) || installation.installedScheduleHash === '') {
      return { code: 'LOCAL', op: 'sync', message: 'This installation may differ from the platform. At the end of the run, call platform.scheduled_task.sync for this client (questions wait for an interactive session).' }
    }
    if (installation.installedScheduleHash === desired) return null
    return {
      code: 'P1',
      op: 'update',
      message: `"${task.title}" changed on the platform. At the end of the run, update this client's schedule with the recipe, then call platform.scheduled_task.install_report.`,
      recipe: this.recipe(task, client, task.status === 'active' && !installation.locallyDisabled),
      report: { taskId: task.id, externalId: installation.externalId, action: 'updated', scheduleHash: desired, stubHash: expectedStubHash(task.id, client) },
    }
  }

  async runFinish(principal: ScheduledTaskPrincipal, input: { runId?: unknown; status?: unknown; summary?: unknown }) {
    if (typeof input.runId !== 'string' || (input.status !== 'succeeded' && input.status !== 'failed')) return { ok: false as const, code: 'invalid_args' as const }
    if (input.summary !== undefined && typeof input.summary !== 'string') return { ok: false as const, code: 'invalid_args' as const }
    const summary = typeof input.summary === 'string' ? input.summary.trim().slice(0, 2000) || null : null
    const run = await this.deps.store.findRun(input.runId)
    const task = run ? await this.deps.store.findTask(principal.tenantId, run.taskId) : null
    if (!run || !task || run.runnerUserId !== principal.userId) return { ok: false as const, code: 'not_found' as const }
    let finished = run
    if (run.status === 'running') {
      finished = (await this.deps.store.finishRun({ runId: run.id, runnerUserId: principal.userId, status: input.status, summary, now: this.now() })) ?? run
      await this.record('scheduled_task.run_finish', principal, task, { runId: run.id, status: input.status })
    } else if (run.status !== input.status) {
      return { ok: false as const, code: 'already_finished' as const, status: run.status }
    }
    const linkedCalls = await this.deps.countLinkedCalls?.({ tenantId: principal.tenantId, runId: run.id }).catch(() => null) ?? null
    return { ok: true as const, runId: finished.id, status: finished.status, linkedToolCalls: linkedCalls }
  }

  /** K5: a `scheduledRunId` csak a principal saját, futó, 24 óránál nem régebbi futására mutathat. */
  async validateRunLink(principal: ScheduledTaskPrincipal, runId: string): Promise<{ ok: true; taskId: string } | { ok: false }> {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return { ok: false }
    const run = await this.deps.store.findRun(runId)
    if (!run || run.runnerUserId !== principal.userId || run.status !== 'running') return { ok: false }
    if (this.now().getTime() - run.startedAt.getTime() > RUN_LINK_MAX_AGE_MS) return { ok: false }
    const task = await this.deps.store.findTask(principal.tenantId, run.taskId)
    return task ? { ok: true, taskId: task.id } : { ok: false }
  }

  // ── S1: munkamenet eleji tájékoztató (§5.1) ───────────────────────────────

  async briefing(principal: ScheduledTaskPrincipal, agentId: string) {
    const { tasks, planTasks, allInstallations } = await this.planTasks(principal, agentId)
    const pending: Array<{ taskId: string; title: string; reason: string; clientType: string }> = []
    const missedCandidates: Array<{ task: TaskRecord; slot: Date; claimKey: string }> = []
    const now = this.now()
    for (const plan of planTasks) {
      const task = tasks.find((row) => row.id === plan.taskId)!
      const live = allInstallations.filter((row) => row.taskId === task.id && row.userId === principal.userId && !row.removedAt)
      if (plan.access === 'not_allowed' || task.status === 'archived') {
        for (const row of live) pending.push({ taskId: task.id, title: task.title, reason: 'remove', clientType: row.clientType })
        continue
      }
      if (plan.access === 'needs_consent' || plan.access === 'needs_reconsent') {
        for (const clientType of task.targets) pending.push({ taskId: task.id, title: task.title, reason: plan.access, clientType })
        continue
      }
      const enabled = task.status === 'active'
      for (const clientType of task.targets) {
        if (enabled && !live.some((row) => row.clientType === clientType)) pending.push({ taskId: task.id, title: task.title, reason: 'not_installed', clientType })
      }
      for (const row of live) {
        if (!task.targets.includes(row.clientType)) {
          pending.push({ taskId: task.id, title: task.title, reason: 'remove', clientType: row.clientType })
          continue
        }
        const desired = scheduleHash({ cron: task.cron, timezone: task.timezone, enabled: enabled && !row.locallyDisabled })
        if (row.installedScheduleHash !== desired) pending.push({ taskId: task.id, title: task.title, reason: 'changed_on_platform', clientType: row.clientType })
      }
      if (enabled && live.length) {
        const computed = this.slotFor(task, now)
        if (computed && computed.slot > task.createdAt && now.getTime() - computed.slot.getTime() > computed.graceMinutes * 60_000) {
          missedCandidates.push({ task, slot: computed.slot, claimKey: task.kind === 'shared' ? principal.userId : '' })
        }
      }
    }
    const runs = missedCandidates.length ? await this.deps.store.findRunsAtSlots(missedCandidates.map(({ task, slot, claimKey }) => ({ taskId: task.id, slot, claimKey }))) : []
    const missed = missedCandidates
      .filter(({ task, slot, claimKey }) => !runs.some((run) => run.taskId === task.id && run.slot.getTime() === slot.getTime() && run.claimKey === claimKey && run.status !== 'missed'))
      .map(({ task, slot }) => ({ taskId: task.id, title: task.title, slot: slot.toISOString() }))
    const unique = pending.filter((row, index) => pending.findIndex((other) => other.taskId === row.taskId && other.clientType === row.clientType && other.reason === row.reason) === index)
    if (!unique.length && !missed.length) return null
    return {
      note: 'If pending is not empty and a row matches your client type, call platform.scheduled_task.sync and ask the user the plan\'s questions. For missed, you may offer to catch up the latest run now: platform.scheduled_task.run_start with catchUp=true, only if the user asks.',
      syncRevision: this.revision(planTasks),
      pending: unique.slice(0, 20),
      missed: missed.slice(0, 10),
    }
  }

  private async record(action: string, principal: ScheduledTaskPrincipal, task: TaskRecord, metadata: Record<string, unknown>) {
    await this.deps.audit.append({
      action, actorType: 'human', actorId: principal.userId, targetType: 'scheduled_task', targetId: task.id, tenantId: task.tenantId,
      metadata: { taskId: task.id, agentId: task.agentId, kind: task.kind, ...metadata },
    })
  }
}

function supportsSyncStub(clientType: string) {
  return clientType === 'claude_routine' || clientType === 'hermes' || clientType === 'goose'
}

/** §6 kliens-képességek: programozható ütemező, vagy kézi recept. */
function clientSteps(clientType: string): string[] {
  switch (clientType) {
    case 'claude_routine':
      return [
        'Create (or update) a Claude Code routine with RemoteTrigger: name = recipe.name, prompt = recipe.stubPrompt exactly, schedule = recipe.cron in recipe.timezone (convert to the timezone the routine expects), enabled = recipe.enabled.',
        'Use the routine id as externalId in platform.scheduled_task.install_report.',
      ]
    case 'hermes':
      return [
        'Add (or update) a Hermes cron job with the cronjob tool: schedule = recipe.cron (in recipe.timezone), prompt = recipe.stubPrompt exactly, enabled = recipe.enabled.',
        'Use the job id as externalId in platform.scheduled_task.install_report.',
      ]
    case 'goose':
      return [
        'Run `goose schedule add` with the cron recipe.cron (in recipe.timezone) and a recipe whose prompt is recipe.stubPrompt exactly.',
        'Use the schedule id as externalId in platform.scheduled_task.install_report.',
      ]
    default:
      return [
        'If this client has a scheduler you can manage, create a scheduled task with recipe.stubPrompt exactly, at recipe.cron in recipe.timezone.',
        'Otherwise show the user these manual steps: open the scheduled tasks of this app, create a task at the time described, paste recipe.stubPrompt as its prompt. Ask the user for the task\'s name or id and report it as externalId.',
      ]
  }
}

export type { PlanAction }

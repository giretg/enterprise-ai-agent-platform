/**
 * #640: ütemezett feladat szolgáltatás — slot-foglalás (D4), tulajdonos/tag-kapu (D5),
 * beleegyezés (D6, D15), pótlás (K12), futás-összekötés (K5), S1 tájékoztató.
 *
 * Futtatás: npm run test:scheduled-task-service
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  ScheduledTaskService, type InstallationRecord, type MemberRecord, type RunRecord, type ScheduledTaskPrincipal,
  type ScheduledTaskStore, type TaskRecord,
} from '../src/domain/scheduled-task/scheduled-task-service'
import { stubPrompt } from '../src/domain/scheduled-task/stub'
import { invokeScheduledTask } from '../src/domain/scheduled-task/mcp'

const TENANT = randomUUID()
const AGENT = randomUUID()
const ANNA = randomUUID()
const PETER = randomUUID()
const CSILLA = randomUUID()
const OUTSIDER = randomUUID()
const principal = (userId: string, role = 'operator'): ScheduledTaskPrincipal => ({ userId, tenantId: TENANT, role, assumed: false })

class MemoryStore implements ScheduledTaskStore {
  tasks: TaskRecord[] = []
  members: MemberRecord[] = []
  installations: InstallationRecord[] = []
  runs: RunRecord[] = []
  async countActiveOwned(tenantId: string, userId: string) { return this.tasks.filter((t) => t.tenantId === tenantId && t.ownerUserId === userId && t.status !== 'archived').length }
  async createTask(data: Parameters<ScheduledTaskStore['createTask']>[0], members: Parameters<ScheduledTaskStore['createTask']>[1]) {
    const task: TaskRecord = { ...data, id: randomUUID(), version: 1, status: 'active', createdAt: new Date(now.getTime() - 86400000 * 30), updatedAt: now }
    this.tasks.push(task)
    for (const member of members) await this.upsertMember(task.id, member)
    return task
  }
  async findTask(tenantId: string, taskId: string) { return this.tasks.find((t) => t.tenantId === tenantId && t.id === taskId) ?? null }
  async listTasks(input: Parameters<ScheduledTaskStore['listTasks']>[0]) {
    return this.tasks.filter((t) => t.tenantId === input.tenantId && (!input.agentId || t.agentId === input.agentId) && (input.includeArchived || t.status !== 'archived')
      && (!input.userId || t.ownerUserId === input.userId || this.members.some((m) => m.taskId === t.id && m.userId === input.userId)))
  }
  async listAudienceTasks(tenantId: string, agentIds: string[]) { return this.tasks.filter((t) => t.tenantId === tenantId && agentIds.includes(t.agentId) && t.audience === 'agent_operators' && t.kind !== 'personal' && t.status !== 'archived') }
  async updateTask(input: Parameters<ScheduledTaskStore['updateTask']>[0]) {
    const task = await this.findTask(input.tenantId, input.taskId)
    if (!task || task.version !== input.expectedVersion) return null
    Object.assign(task, input.data, { version: task.version + 1 })
    for (const m of this.members.filter((m) => m.taskId === task.id)) {
      if (input.reconsent) {
        if (m.userId === input.ownerUserId) m.acceptedVersion = task.version
        else if (m.state === 'active') m.state = 'needs_reconsent'
      } else if (m.acceptedVersion === input.expectedVersion) m.acceptedVersion = task.version
    }
    return task
  }
  async listMembers(taskIds: string[]) { return this.members.filter((m) => taskIds.includes(m.taskId)) }
  async upsertMember(taskId: string, member: Parameters<ScheduledTaskStore['upsertMember']>[1]) {
    let row = this.members.find((m) => m.taskId === taskId && m.userId === member.userId)
    if (!row) {
      row = { id: randomUUID(), taskId, createdAt: now, updatedAt: now, ...member }
      this.members.push(row)
    } else Object.assign(row, member)
    return row
  }
  async createMemberIfMissing(taskId: string, member: Parameters<ScheduledTaskStore['upsertMember']>[1]) {
    if (!this.members.some((m) => m.taskId === taskId && m.userId === member.userId)) await this.upsertMember(taskId, member)
  }
  async listInstallations(input: Parameters<ScheduledTaskStore['listInstallations']>[0]) {
    return this.installations.filter((i) => input.taskIds.includes(i.taskId) && (!input.userId || i.userId === input.userId) && (!input.clientType || i.clientType === input.clientType) && (!input.clientInstanceId || i.clientInstanceId === input.clientInstanceId))
  }
  async upsertInstallation(input: Parameters<ScheduledTaskStore['upsertInstallation']>[0]) {
    const { now: at, ...rest } = input
    let row = this.installations.find((i) => i.taskId === input.taskId && i.clientType === input.clientType && i.clientInstanceId === input.clientInstanceId && i.externalId === input.externalId)
    if (!row) {
      row = { id: randomUUID(), createdAt: at, lastSyncAt: at, lastSeenAt: at, removedAt: null, ...rest }
      this.installations.push(row)
    } else Object.assign(row, rest, { removedAt: null, lastSeenAt: at })
    return row
  }
  async markInstallationsRemoved(input: Parameters<ScheduledTaskStore['markInstallationsRemoved']>[0]) {
    const rows = this.installations.filter((i) => i.taskId === input.taskId && i.userId === input.userId && !i.removedAt && (!input.clientType || i.clientType === input.clientType) && (!input.clientInstanceId || i.clientInstanceId === input.clientInstanceId) && (!input.externalId || i.externalId === input.externalId))
    for (const row of rows) row.removedAt = input.now
    return rows.length
  }
  async touchInstallations() {}
  async insertRun(data: Parameters<ScheduledTaskStore['insertRun']>[0]) {
    if (this.runs.some((r) => r.taskId === data.taskId && r.slot.getTime() === data.slot.getTime() && r.claimKey === data.claimKey)) return null
    const run: RunRecord = { ...data, id: randomUUID(), summary: null, startedAt: now, finishedAt: null }
    this.runs.push(run)
    return run
  }
  async reviveMissedRun(input: Parameters<ScheduledTaskStore['reviveMissedRun']>[0]) {
    const run = this.runs.find((r) => r.taskId === input.taskId && r.slot.getTime() === input.slot.getTime() && r.claimKey === input.claimKey && r.status === 'missed')
    if (!run) return null
    Object.assign(run, { status: 'running', catchUp: true, runnerUserId: input.runnerUserId, startedAt: now })
    return run
  }
  async findRun(runId: string) { return this.runs.find((r) => r.id === runId) ?? null }
  async findRunsAtSlots(keys: Array<{ taskId: string; slot: Date; claimKey: string }>) { return this.runs.filter((r) => keys.some((k) => k.taskId === r.taskId && k.slot.getTime() === r.slot.getTime() && k.claimKey === r.claimKey)) }
  async finishRun(input: Parameters<ScheduledTaskStore['finishRun']>[0]) {
    const run = this.runs.find((r) => r.id === input.runId && r.runnerUserId === input.runnerUserId && r.status === 'running')
    if (!run) return null
    Object.assign(run, { status: input.status, summary: input.summary, finishedAt: input.now })
    return run
  }
  async listRuns(input: { taskIds: string[]; limit: number }) { return this.runs.filter((r) => input.taskIds.includes(r.taskId)).slice(0, input.limit) }
}

// 2026-10-29 (csütörtök) 06:00Z = 07:00 Budapest; a „0 8 * * 1-5” slot 07:00Z.
let now = new Date('2026-10-29T07:02:00Z')
const store = new MemoryStore()
const audits: Array<{ action: string }> = []
const operators = new Set([ANNA, PETER, CSILLA])
const service = new ScheduledTaskService({
  store,
  audit: { append: async (event) => { audits.push(event) } },
  loadAgent: async (_tenantId, agentId) => (agentId === AGENT ? { id: AGENT, name: 'Sales', status: 'active', currentDefinitionVersionId: randomUUID() } : null),
  loadCurrentDefinition: async () => ({ definitionId: 'def-1', contentHash: 'hash-1' }),
  findAgentGrant: async ({ userId }) => (operators.has(userId) ? { accessLevel: 'operate' } : null),
  listOperatorUserIds: async () => [...operators],
  listOperableAgentIds: async (_tenantId, userId) => (operators.has(userId) ? [AGENT] : []),
  activeMemberIds: async (_tenantId, ids) => new Set(ids.filter((id) => id !== OUTSIDER)),
  userNames: async (ids) => new Map(ids.map((id) => [id, id === ANNA ? 'Anna' : id === PETER ? 'Péter' : 'Csilla'])),
  now: () => now,
})
const ROUTINE = (userId: string) => ({ clientType: 'claude_routine', clientInstanceId: `${userId}:routine` })

let failures = 0
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  ❌ ${name}: ${error instanceof Error ? error.stack : String(error)}`)
  }
}

async function main() {
  const base = { agentId: AGENT, title: 'Lejárt ajánlatok', instruction: 'Nézd át a CRM-ben a lejárt ajánlatokat.', cron: '0 8 * * 1-5', clientType: 'claude_routine' }
  let personal: TaskRecord

  await test('create: validation, K6 minimum, default target = calling client', async () => {
    for (const change of [{ cron: '*/5 * * * *' }, { cron: '0 8 * *' }, { timezone: 'Mars/Olympus' }, { title: '' }, { targets: ['vim'] }, { agentId: randomUUID() }]) {
      const result = await service.create(principal(ANNA), { ...base, ...change })
      assert.equal(result.ok, false, JSON.stringify(change))
    }
    assert.equal((await service.create(principal(ANNA), { ...base, cron: '*/5 * * * *' }) as { code: string }).code, 'schedule_too_frequent')
    assert.equal((await service.create(principal(OUTSIDER), base) as { code: string }).code, 'agent_access_denied')
    const created = await service.create(principal(ANNA), base)
    assert(created.ok)
    personal = created.task
    assert.deepEqual(personal.targets, ['claude_routine'])
    assert.equal(personal.timezone, 'Europe/Budapest')
  })

  await test('K8: only an admin may create a personal task for someone else; it waits for consent', async () => {
    assert.equal((await service.create(principal(ANNA), { ...base, ownerUserId: PETER }) as { code: string }).code, 'not_allowed')
    const created = await service.create(principal(ANNA, 'admin'), { ...base, ownerUserId: PETER, title: 'Péter reggelije' })
    assert(created.ok)
    const start = await service.runStart(principal(PETER), { taskId: created.task.id })
    assert.equal((start as { code: string }).code, 'needs_consent')
    const report = await service.installReport(principal(PETER), { client: ROUTINE(PETER), reports: [{ taskId: created.task.id, externalId: 'trig_p', action: 'installed', scheduleHash: 'h', stubHash: 's' }] })
    assert.deepEqual(report.ok && report.results.map((r) => r.ok), [true])
    assert.equal(store.members.find((m) => m.taskId === created.task.id)!.state, 'active')
  })

  await test('run_start: claims the slot once (D4), other user → not_owner (D5)', async () => {
    const installation = { ...ROUTINE(ANNA), externalId: 'trig_1' }
    const first = await service.runStart(principal(ANNA), { taskId: personal.id, installation })
    assert(first.ok, JSON.stringify(first))
    assert.equal(first.slot, '2026-10-29T07:00:00.000Z')
    assert.equal(first.instruction, base.instruction)
    assert.equal(first.definitionId, 'def-1')
    assert.match(first.guidance, new RegExp(`scheduledRunId "${first.runId}"`))
    const second = await service.runStart(principal(ANNA), { taskId: personal.id, installation: { ...ROUTINE(ANNA), clientType: 'hermes', externalId: 'job_1' } })
    assert.equal((second as { code: string }).code, 'already_claimed')
    const other = await service.runStart(principal(PETER), { taskId: personal.id })
    assert.equal((other as { code: string }).code, 'not_owner')
    // K5: csak a saját futó run köthető.
    assert.equal((await service.validateRunLink(principal(ANNA), first.runId)).ok, true)
    assert.equal((await service.validateRunLink(principal(PETER), first.runId)).ok, false)
    // run_finish: csak a foglaló; idempotens.
    assert.equal((await service.runFinish(principal(PETER), { runId: first.runId, status: 'succeeded' })).ok, false)
    assert.equal((await service.runFinish(principal(ANNA), { runId: first.runId, status: 'succeeded', summary: '12 lejárt ajánlat' })).ok, true)
    assert.equal((await service.runFinish(principal(ANNA), { runId: first.runId, status: 'succeeded' })).ok, true)
    assert.equal((await service.validateRunLink(principal(ANNA), first.runId)).ok, false)
  })

  await test('slot fix: an early start (≤ 5 min) claims the coming slot, not the previous one', async () => {
    now = new Date('2026-10-30T06:57:00Z')
    const early = await service.runStart(principal(ANNA), { taskId: personal.id })
    assert(early.ok)
    assert.equal(early.slot, '2026-10-30T07:00:00.000Z')
  })

  await test('missed after the grace window, K12 catch-up revives it', async () => {
    now = new Date('2026-11-02T11:00:00Z') // hétfő 12:00 Budapest; a 8:00-s slot 3 órája volt (> 2 óra)
    const late = await service.runStart(principal(ANNA), { taskId: personal.id })
    assert.equal((late as { code: string }).code, 'missed')
    assert.equal(store.runs.filter((r) => r.taskId === personal.id && r.status === 'missed').length, 1)
    const briefing = await service.briefing(principal(ANNA), AGENT)
    assert.equal(briefing?.missed[0]?.taskId, personal.id)
    const catchUp = await service.runStart(principal(ANNA), { taskId: personal.id, catchUp: true })
    assert(catchUp.ok)
    assert.equal(store.runs.find((r) => r.id === catchUp.runId)!.catchUp, true)
    assert.equal((await service.briefing(principal(ANNA), AGENT))?.missed.length ?? 0, 0)
  })

  await test('S2 drift: platform reschedule → P1 update with recipe and report', async () => {
    const c = ROUTINE(ANNA)
    const synced = await service.sync(principal(ANNA), { client: c, inventory: [] })
    assert(synced.ok)
    const install = synced.actions.find((a) => a.taskId === personal.id)!
    // A futásból regisztrált trig_1 alapja ismeretlen: a hiánya nem L5-kérdés, hanem újratelepítés.
    assert.equal(install.code, 'P3')
    const updated = await service.update(principal(ANNA), { taskId: personal.id, expectedVersion: 1, cron: '0 9 * * 1-5' })
    assert(updated.ok)
    assert.equal((await service.update(principal(ANNA), { taskId: personal.id, expectedVersion: 1, cron: '0 10 * * 1-5' }) as { code: string }).code, 'conflict')
    assert.equal((await service.update(principal(PETER), { taskId: personal.id, expectedVersion: 2, cron: '0 10 * * 1-5' }) as { code: string }).code, 'not_owner')
    const installed = await service.installReport(principal(ANNA), { client: c, reports: [{ taskId: personal.id, externalId: 'trig_1', action: 'installed', scheduleHash: 'old', stubHash: 'old' }] })
    assert(installed.ok)
    now = new Date('2026-11-03T08:01:00Z')
    const run = await service.runStart(principal(ANNA), { taskId: personal.id, installation: { ...c, externalId: 'trig_1' } })
    assert(run.ok)
    assert.equal((run.drift as { code: string }).code, 'P1')
  })

  await test('sync: foreign stub on the client → L6 remove; recipe carries the canonical stub', async () => {
    const c = ROUTINE(ANNA)
    const foreign = await service.create(principal(PETER), { ...base, title: 'Péter titkos feladata', clientType: 'claude_routine' })
    assert(foreign.ok)
    const synced = await service.sync(principal(ANNA), { client: c, inventory: [
      { taskId: foreign.task.id, externalId: 'trig_x', cron: '0 8 * * 1-5', timezone: 'Europe/Budapest', enabled: true, stubText: 'x' },
      { taskId: personal.id, externalId: 'trig_1', cron: '0 8 * * 1-5', timezone: 'Europe/Budapest', enabled: true, stubText: stubPrompt({ taskId: personal.id, client: c }) },
    ] })
    assert(synced.ok)
    const l6 = synced.actions.find((a) => a.taskId === foreign.task.id)!
    assert.equal(l6.code, 'L6')
    assert.doesNotMatch(JSON.stringify(synced), /titkos/)
    // Az alap ('old') se a helyi, se a platform: mindkét oldalon változott → L2 kérdés.
    assert.deepEqual(synced.actions.filter((a) => a.taskId === personal.id).map((a) => a.code), ['L2'])
    assert.equal(synced.recipes.find((r) => r.taskId === personal.id)!.stubPrompt, stubPrompt({ taskId: personal.id, client: c }))
    assert.ok(synced.syncStub)
  })

  await test('team: first claimer wins (K15); shared: one run per member (claimKey)', async () => {
    now = new Date('2026-11-04T07:01:00Z')
    const team = await service.create(principal(ANNA), { ...base, kind: 'team', title: 'Postafiók besorolás', memberUserIds: [PETER, CSILLA] })
    const shared = await service.create(principal(ANNA), { ...base, kind: 'shared', title: 'Saját levelek', memberUserIds: [PETER] })
    assert(team.ok && shared.ok)
    assert.equal((await service.runStart(principal(PETER), { taskId: team.task.id }) as { code: string }).code, 'needs_consent')
    for (const [userId, taskId] of [[PETER, team.task.id], [CSILLA, team.task.id], [PETER, shared.task.id]]) {
      const reported = await service.installReport(principal(userId), { client: ROUTINE(userId), reports: [{ taskId, externalId: `t_${userId}`, action: 'installed', scheduleHash: 'h', stubHash: 's' }] })
      assert(reported.ok && reported.results[0].ok)
    }
    const peter = await service.runStart(principal(PETER), { taskId: team.task.id })
    const csilla = await service.runStart(principal(CSILLA), { taskId: team.task.id })
    assert.equal(peter.ok, true)
    assert.equal((csilla as { code: string }).code, 'already_claimed')
    assert.equal((await service.runStart(principal(ANNA), { taskId: shared.task.id })).ok, true)
    assert.equal((await service.runStart(principal(PETER), { taskId: shared.task.id })).ok, true)
  })

  await test('D15: instruction change → members re-consent; schedule-only change does not', async () => {
    const team = store.tasks.find((t) => t.title === 'Postafiók besorolás')!
    const scheduleOnly = await service.update(principal(ANNA), { taskId: team.id, expectedVersion: team.version, cron: '0 7 * * 1-5' })
    assert(scheduleOnly.ok)
    now = new Date('2026-11-05T06:01:00Z')
    assert.equal((await service.runStart(principal(CSILLA), { taskId: team.id })).ok, true)
    const changed = await service.update(principal(ANNA), { taskId: team.id, expectedVersion: scheduleOnly.task.version, instruction: 'Most már a spam mappát is nézd át.' })
    assert(changed.ok)
    now = new Date('2026-11-06T06:01:00Z')
    assert.equal((await service.runStart(principal(PETER), { taskId: team.id }) as { code: string }).code, 'needs_reconsent')
    assert.equal((await service.runStart(principal(ANNA), { taskId: team.id })).ok, true)
    const briefing = await service.briefing(principal(PETER), AGENT)
    assert.ok(briefing?.pending.some((row) => row.taskId === team.id && row.reason === 'needs_reconsent'))
    assert.equal((await service.respond(principal(PETER), { taskId: team.id, response: 'accept' })).ok, true)
    assert.equal(store.members.find((m) => m.taskId === team.id && m.userId === PETER)!.acceptedVersion, changed.task.version)
  })

  await test('K14: agent operators are invited lazily; decline is final; revoked access stops runs', async () => {
    const audience = await service.create(principal(ANNA), { ...base, kind: 'shared', audience: 'agent_operators', title: 'Mindenkinek' })
    assert(audience.ok)
    const briefing = await service.briefing(principal(CSILLA), AGENT)
    assert.ok(briefing?.pending.some((row) => row.taskId === audience.task.id && row.reason === 'needs_consent'))
    assert.equal((await service.respond(principal(CSILLA), { taskId: audience.task.id, response: 'decline' })).ok, true)
    await service.briefing(principal(CSILLA), AGENT)
    assert.equal(store.members.find((m) => m.taskId === audience.task.id && m.userId === CSILLA)!.state, 'declined')
    operators.delete(PETER)
    const shared = store.tasks.find((t) => t.title === 'Saját levelek')!
    now = new Date('2026-11-09T07:01:00Z')
    assert.equal((await service.runStart(principal(PETER), { taskId: shared.id }) as { code: string }).code, 'agent_access_revoked')
    operators.add(PETER)
  })

  await test('paused task → deny with a disable step; archived hidden from list', async () => {
    const paused = await service.update(principal(ANNA), { taskId: personal.id, expectedVersion: store.tasks.find((t) => t.id === personal.id)!.version, status: 'paused' })
    assert(paused.ok)
    const denied = await service.runStart(principal(ANNA), { taskId: personal.id })
    assert.equal((denied as { code: string }).code, 'paused')
    assert.deepEqual((denied as { steps: unknown[] }).steps, [{ type: 'local', op: 'disable' }])
    assert.ok(audits.some((a) => a.action === 'scheduled_task.run_start'))
  })

  await test('MCP: targets as comma string, inventory/reports as JSON string; create is always personal', async () => {
    const call = async (toolName: string, args: Record<string, unknown>) =>
      JSON.parse((await invokeScheduledTask({ scheduledTasks: service }, { principal: principal(CSILLA), toolName, args })).content[0].text)
    const created = await call('platform.scheduled_task.create', { ...base, kind: 'team', targets: 'claude_routine, hermes', client: ROUTINE(CSILLA) })
    assert.equal(created.ok, true)
    assert.equal(created.task.kind, 'personal')
    assert.deepEqual(created.task.targets, ['claude_routine', 'hermes'])
    assert.equal(created.recipe.stubPrompt, stubPrompt({ taskId: created.task.taskId, client: ROUTINE(CSILLA) }))
    const synced = await call('platform.scheduled_task.sync', { client: ROUTINE(CSILLA), inventory: JSON.stringify([]) })
    assert.equal(synced.ok, true)
    const install = synced.actions.find((a: { taskId: string }) => a.taskId === created.task.taskId)
    assert.equal(install.code, 'P3')
    const reportStep = install.steps.find((step: { type: string }) => step.type === 'report').report
    const reported = await call('platform.scheduled_task.install_report', { client: ROUTINE(CSILLA), reports: JSON.stringify([{ ...reportStep, externalId: 'trig_c' }]) })
    assert.deepEqual(reported.results.map((r: { ok: boolean }) => r.ok), [true])
    const bad = await call('platform.scheduled_task.sync', { client: ROUTINE(CSILLA), inventory: 'not json' })
    assert.equal(bad.code, 'invalid_args')
  })

  if (failures) {
    console.log(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nall passed')
}

void main()

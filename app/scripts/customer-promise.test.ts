import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { CustomerPromiseService, type CustomerPromiseStore, type CustomerPromiseRecord, type CustomerPromiseInsert, type CustomerPromiseListInput } from '../src/domain/customer-promise/customer-promise-service'

class MemoryPromises implements CustomerPromiseStore {
  rows: CustomerPromiseRecord[] = []
  async insertUnderLimit(input: CustomerPromiseInsert) {
    if (this.rows.filter(row => row.tenantId === input.tenantId && row.agentId === input.agentId && ['open', 'claimed'].includes(row.status) && row.dueAt >= new Date()).length >= 50) return null
    const row: CustomerPromiseRecord = { ...input, id: randomUUID(), status: 'open', claimedAt: null, claimClient: null, claimExternalId: null, resolvedAt: null, resolvedNote: null, createdAt: new Date(), updatedAt: new Date() }
    this.rows.push(row)
    return row
  }
  async findById(tenantId: string, id: string) { return this.rows.find(row => row.tenantId === tenantId && row.id === id) ?? null }
  async list(input: CustomerPromiseListInput, now: Date) {
    const match = (row: CustomerPromiseRecord) => row.tenantId === input.tenantId && (!input.ownerUserId || input.ownerUserId === row.ownerUserId) && (!input.agentId || input.agentId === row.agentId) && (!input.status || (input.status === 'active' ? ['open', 'claimed'].includes(row.status) : row.status === input.status)) && (input.due !== 'overdue' || (['open', 'claimed'].includes(row.status) && row.dueAt < now)) && (input.due !== 'upcoming' || row.dueAt >= now)
    const sorted = this.rows.filter(match).sort((a, b) => {
      if (input.due !== 'overdue' && input.due !== 'upcoming') {
        const aUp = a.dueAt >= now ? 0 : 1
        const bUp = b.dueAt >= now ? 0 : 1
        if (aUp !== bUp) return aUp - bUp
      }
      return a.dueAt.getTime() - b.dueAt.getTime() || a.id.localeCompare(b.id)
    })
    return sorted.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 50))
  }
  async countUrgentForUser(tenantId: string, userId: string, until: Date) { return this.rows.filter(row => row.tenantId === tenantId && row.ownerUserId === userId && ['open', 'claimed'].includes(row.status) && row.dueAt <= until).length }
  async resolve(input: Parameters<CustomerPromiseStore['resolve']>[0]) {
    const row = await this.findById(input.tenantId, input.id)
    if (!row || !['open', 'claimed'].includes(row.status)) return null
    Object.assign(row, { status: input.status, resolvedNote: input.note, resolvedAt: input.now })
    return row
  }
}

async function main() {
  const store = new MemoryPromises()
  const audits: unknown[] = []
  const service = new CustomerPromiseService(store, { append: async event => { audits.push(event) } })
  const input = { tenantId: randomUUID(), agentId: randomUUID(), ownerUserId: randomUUID(), definitionId: randomUUID(), title: 'Callback', commitment: 'Call private customer tomorrow', customerEmail: 'private@example.com', dueAt: new Date(Date.now() + 3600000).toISOString() }
  for (const change of [{ title: '' }, { commitment: 'x'.repeat(2001) }, { dueAt: 'tomorrow' }, { dueAt: new Date(Date.now() - 1000).toISOString() }, { dueAt: new Date(Date.now() + 367 * 86400000).toISOString() }, { dueAt: '2027-02-30T10:00:00Z' }, { timezone: 'Mars/Olympus' }, { timezone: '+01:00' }, { customerEmail: 'bad' }]) {
    assert.deepEqual(await service.register({ ...input, ...change }), { ok: false, code: 'invalid_args' })
  }
  const registered = await service.register(input)
  assert(registered.ok)
  const id = registered.row.id
  assert.equal(registered.row.timezone, 'Europe/Budapest')
  assert.deepEqual(await service.get({ tenantId: randomUUID(), userId: input.ownerUserId, promiseId: id }), { ok: false, code: 'not_found' })
  assert.deepEqual(await service.get({ tenantId: input.tenantId, userId: randomUUID(), promiseId: id }), { ok: false, code: 'not_allowed' })
  assert.deepEqual(await service.resolve({ tenantId: input.tenantId, actorUserId: randomUUID(), promiseId: id, status: 'fulfilled' }), { ok: false, code: 'not_allowed' })
  assert.equal((await service.list({ tenantId: randomUUID() })).length, 0)
  registered.row.dueAt = new Date(Date.now() - 1000)
  assert.equal((await service.list({ tenantId: input.tenantId, due: 'overdue' }))[0].overdue, true)
  assert.equal(await service.countUrgentForUser(input.tenantId, input.ownerUserId), 1)
  assert((await service.resolve({ tenantId: input.tenantId, actorUserId: input.ownerUserId, promiseId: id, status: 'fulfilled', note: 'Done' })).ok)
  assert.deepEqual(await service.resolve({ tenantId: input.tenantId, actorUserId: input.ownerUserId, promiseId: id, status: 'cancelled' }), { ok: false, code: 'already_resolved' })
  const cancel = await service.register(input)
  assert(cancel.ok)
  assert((await service.resolve({ tenantId: input.tenantId, actorUserId: randomUUID(), allowTenantScope: true, promiseId: cancel.row.id, status: 'cancelled' })).ok)
  assert.equal(await service.countUrgentForUser(input.tenantId, input.ownerUserId), 0)
  assert.equal((await service.list({ tenantId: input.tenantId, status: 'fulfilled', due: 'overdue' })).length, 0)
  for (let i = 0; i < 50; i++) assert((await service.register({ ...input, ownerUserId: randomUUID() })).ok)
  const active = store.rows.find(row => row.tenantId === input.tenantId && row.status === 'open')!
  active.status = 'claimed'
  assert.deepEqual(await service.register(input), { ok: false, code: 'limit_exceeded' })
  // A lejárt, de le nem zárt vállalás nem foglal helyet, és folyamatban státuszban is lejártként látszik.
  active.dueAt = new Date(Date.now() - 1000)
  active.ownerUserId = input.ownerUserId
  const claimedOverdue = (await service.list({ tenantId: input.tenantId, due: 'overdue' })).find(row => row.id === active.id)
  assert.equal(claimedOverdue?.overdue, true)
  assert.equal(await service.countUrgentForUser(input.tenantId, input.ownerUserId), 1)
  const afterOverdue = await service.register(input)
  assert(afterOverdue.ok)
  assert.deepEqual(await service.register(input), { ok: false, code: 'limit_exceeded' })
  assert((await service.register({ ...input, tenantId: randomUUID() })).ok)
  assert.equal((await service.list({ tenantId: input.tenantId, limit: 200 })).length, 51)
  const firstPage = await service.list({ tenantId: input.tenantId, limit: 50 })
  const secondPage = await service.list({ tenantId: input.tenantId, limit: 50, offset: 50 })
  assert.equal(secondPage.length, 3)
  assert(!firstPage.some(row => secondPage.some(other => other.id === row.id)))
  assert.equal((await service.list({ tenantId: input.tenantId, offset: -1.5 }))[0].id, firstPage[0].id)
  // MCP/briefing take:50 must keep live commitments visible when overdue backlog fills the old dueAt-asc window.
  const mask = { tenantId: randomUUID(), agentId: randomUUID(), ownerUserId: randomUUID(), definitionId: randomUUID() }
  for (let i = 0; i < 50; i++) {
    store.rows.push({
      id: randomUUID(), ...mask, title: `Overdue ${i}`, commitment: 'stale',
      customerName: null, customerEmail: null, customerRef: null, channel: null,
      dueAt: new Date(Date.now() - (i + 2) * 86400000), timezone: 'Europe/Budapest', status: 'open',
      claimedAt: null, claimClient: null, claimExternalId: null, resolvedAt: null, resolvedNote: null,
      createdAt: new Date(), updatedAt: new Date(),
    })
  }
  const live = await service.register({
    ...mask, title: 'Still live', commitment: 'Call tomorrow',
    dueAt: new Date(Date.now() + 2 * 86400000).toISOString(),
  })
  assert(live.ok)
  const briefing = await service.list({ tenantId: mask.tenantId, ownerUserId: mask.ownerUserId, agentId: mask.agentId, status: 'active', limit: 50 })
  assert.equal(briefing.length, 50)
  assert.ok(briefing.some(row => row.id === live.row.id), 'upcoming promise must not be masked by overdue backlog')
  assert.equal(briefing[0].id, live.row.id)
  assert.equal(briefing.filter(row => !row.overdue).length, 1)
  const serialized = JSON.stringify(audits)
  for (const privateText of ['private@example.com', 'Call private customer', 'Done']) assert(!serialized.includes(privateText))
  console.log('OK customer promises: validation, tenant/owner isolation, limit, lifecycle, overdue, badge, PII-free audit')
}
main().catch(error => { console.error(error); process.exitCode = 1 })

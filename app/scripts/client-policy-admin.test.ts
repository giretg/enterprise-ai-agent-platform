import assert from 'node:assert/strict'
import { AdminPolicyError, adminPolicySaveSchema, adminPolicyView, saveAdminPolicy, type AdminPolicyStore, type AdminPolicySave } from '../src/domain/client-policy/admin-policy'
import type { PolicyRow } from '../src/domain/client-policy/resolve-effective-policy'
import type { AuditAppendInput } from '../src/lib/audit/types'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import { assertAuditMetadataSafe } from '../src/lib/audit/payload-guard'

const T = '11111111-1111-4111-8111-111111111111'
const U = '22222222-2222-4222-8222-222222222222'
const A = '33333333-3333-4333-8333-333333333333'
const FOREIGN = '44444444-4444-4444-8444-444444444444'
const actor = { tenantId: T, userId: U, role: 'admin' }
let rows: PolicyRow[] = []
let events: AuditAppendInput[] = []
let failAudit = false
let rejectWrite = false
const store: AdminPolicyStore = {
  transaction: async (tenantId, run) => {
    assert.equal(tenantId, T)
    const nextRows = structuredClone(rows)
    const nextEvents = structuredClone(events)
    const result = await run({
      targetExists: async (target) => target.scopeId === (target.scope === 'tenant' ? T : target.scope === 'user' ? U : A),
      find: async (target) => nextRows.find((r) => r.scope === target.scope && r.scopeId === target.scopeId) ?? null,
      save: async (row, expectedVersion) => {
        const index = nextRows.findIndex((r) => r.scope === row.scope && r.scopeId === row.scopeId)
        if (rejectWrite || (nextRows[index]?.version ?? 0) !== expectedVersion) return false
        if (index >= 0) nextRows[index] = row
        else nextRows.push(row)
        return true
      },
      audit: async (event) => {
        if (failAudit) throw new Error('audit_unavailable')
        assertAuditActionRegistered(event.action)
        assertAuditMetadataSafe(event.metadata)
        nextEvents.push(event)
      },
    })
    rows = nextRows
    events = nextEvents
    return result
  },
}
const input = (patch: Partial<AdminPolicySave> = {}): AdminPolicySave => ({
  scope: 'tenant', scopeId: T, preset: 'bound', capabilities: {}, version: 0, confirmWidening: false, ...patch,
})
const rejected = (code: AdminPolicyError['code']) => (error: unknown) => error instanceof AdminPolicyError && error.code === code

async function main() {
  for (const bad of [
    { capabilities: { arbitrary: 'free' } }, { capabilities: { browser: 'unknown' } },
    { capabilities: { models: ['foreign-model'] } }, { capabilities: { floor: 'off' } },
    { preset: 'unknown' }, { version: -1 }, { version: 1.5 }, { confirmWidening: 'yes' },
    { scope: 'platform' }, { scopeId: 'bad-id' }, { toolOverrides: { '*': 'allow' } },
  ]) assert.equal(adminPolicySaveSchema.safeParse({ ...input(), ...bad }).success, false)

  await assert.rejects(saveAdminPolicy(store, { ...actor, role: 'operator' }, input()), rejected('forbidden'))
  for (const scope of ['tenant', 'user', 'agent'] as const) {
    await assert.rejects(saveAdminPolicy(store, actor, input({ scope, scopeId: FOREIGN })), rejected('not_found'))
  }
  assert.equal(rows.length, 0)
  assert.equal(events.length, 0)

  assert.equal((await saveAdminPolicy(store, actor, input())).version, 1)
  assert.equal(events.length, 1)
  assert.equal(events[0].tenantId, T)
  await assert.rejects(saveAdminPolicy(store, actor, input()), rejected('version_conflict'))
  assert.equal(events.length, 1)

  const user = input({ scope: 'user', scopeId: U, preset: null, capabilities: { code_execution: 'local_with_approval' } })
  await assert.rejects(saveAdminPolicy(store, actor, user), (error: unknown) =>
    rejected('confirmation_required')(error) && (error as AdminPolicyError).capabilities.includes('code_execution'))
  assert.equal(rows.length, 1)
  await saveAdminPolicy(store, actor, { ...user, confirmWidening: true })
  assert.deepEqual(events.slice(-2).map((e) => e.action), ['client_policy.save', 'client_policy.user_exception'])
  await assert.rejects(saveAdminPolicy(store, actor, { ...user, preset: 'free', version: 1 }), rejected('confirmation_required'))

  // The editor preserves independent model/tool restrictions and can remove overrides to inherit defaults.
  rows[1].capabilities = { models: ['company-model'], code_execution: 'denied' }
  rows[1].toolOverrides = { 'mcp__crm__*': 'deny' }
  await saveAdminPolicy(store, actor, { ...user, capabilities: {}, version: 1 })
  assert.deepEqual(rows[1].capabilities, { models: ['company-model'] })
  assert.deepEqual(rows[1].toolOverrides, { 'mcp__crm__*': 'deny' })
  assert.deepEqual(adminPolicyView(rows[1])?.capabilities, {})
  assert.equal(rows[1].version, 2)

  // Agent ceilings may be looser than tenant defaults without granting user exceptions.
  await saveAdminPolicy(store, actor, input({ scope: 'agent', scopeId: A, preset: 'free' }))
  assert.equal(events.at(-1)?.action, 'client_policy.save')

  const before = structuredClone({ rows, events })
  failAudit = true
  await assert.rejects(saveAdminPolicy(store, actor, input({ version: 1, preset: 'standard' })), /audit_unavailable/)
  assert.deepEqual({ rows, events }, before)
  failAudit = false
  rejectWrite = true
  await assert.rejects(saveAdminPolicy(store, actor, input({ version: 1 })), rejected('version_conflict'))
  assert.deepEqual({ rows, events }, before)
  console.log('client-policy-admin: validation, tenant isolation, D3, versioning, override preservation and audit rollback OK')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })

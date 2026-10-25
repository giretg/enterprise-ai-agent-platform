/** Run: npx tsx scripts/customer-promise-ui.test.ts — actual actions with isolated dependencies. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { z } from 'zod'
import { hasMinimumRole } from '../src/lib/iam-policy'

const output = ts.transpileModule(readFileSync('src/app/actions/customer-promise.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const userId = '10000000-0000-4000-8000-000000000001'
const promiseId = '10000000-0000-4000-8000-000000000002'
let role = 'viewer'
let rowCount = 0
let listInput: Record<string, unknown> = {}
let resolveInput: Record<string, unknown> = {}
const exported: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
const deps: Record<string, unknown> = {
  'next/cache': { revalidatePath() {} },
  zod: { z },
  '@/auth/tenant-context': { requireTenantRole: async () => ({ activeTenantId: 'tenant-a', activeTenantRole: role, user: { id: userId } }), TenantAuthError: class extends Error {} },
  '@/lib/iam-policy': { hasMinimumRole },
  '@/lib/result': { ok: (data: unknown) => ({ success: true, data }), fail: (error: string) => ({ success: false, error }) },
  '@/repositories/postgres': { repositories: { users: { findManyByIds: async () => [] }, agents: { findMany: async ({ ids }: { ids: string[] }) => ids.map((id) => ({ id, name: 'Teammate' })) } } },
  '@/domain/gateway-services': { services: { customerPromises: {
    list: async (input: Record<string, unknown>) => { listInput = input; return Array.from({ length: rowCount }, (_, index) => ({ id: String(index), agentId: 'agent', ownerUserId: userId, status: 'open', dueAt: new Date('2026-12-01T10:00:00Z') })) },
    // A denied domain response must remain denied at the action boundary.
    resolve: async (input: Record<string, unknown>) => { resolveInput = input; return { ok: false, code: 'not_allowed' } },
  } } },
}
runInNewContext(output, { exports: exported, require: (name: string) => { assert.ok(name in deps, name); return deps[name] } })

async function main() {
  for (const currentRole of ['viewer', 'operator', 'approver', 'admin']) {
    role = currentRole
    await exported.listCustomerPromisesAction()
    assert.equal(listInput.tenantId, 'tenant-a')
    assert.equal(listInput.ownerUserId, ['approver', 'admin'].includes(role) ? undefined : userId)
    assert.equal(listInput.status, 'active', 'resolved history cannot hide open commitments')
    const result = await exported.resolveCustomerPromiseAction({ promiseId, status: 'fulfilled' })
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { success: false, error: 'not_allowed' })
    assert.equal(resolveInput.tenantId, 'tenant-a')
    assert.equal(resolveInput.actorUserId, userId)
    assert.equal(resolveInput.allowTenantScope, ['approver', 'admin'].includes(role))
  }
  await exported.listCustomerPromisesAction(undefined, true)
  assert.equal(listInput.status, undefined)
  rowCount = 51
  const paged = JSON.parse(JSON.stringify(await exported.listCustomerPromisesAction(undefined, false, 1)))
  assert.equal(listInput.offset, 50)
  assert.equal(listInput.limit, 51)
  assert.equal(paged.data.promises.length, 50)
  assert.equal(paged.data.hasMore, true)
  rowCount = 50
  const lastPage = JSON.parse(JSON.stringify(await exported.listCustomerPromisesAction(undefined, false, 2)))
  assert.equal(listInput.offset, 100)
  assert.equal(lastPage.data.hasMore, false)
  for (const invalidPage of [-1, 1.5, Number.MAX_SAFE_INTEGER, Infinity]) {
    const invalid = await exported.listCustomerPromisesAction(undefined, false, invalidPage)
    assert.deepEqual(JSON.parse(JSON.stringify(invalid)), { success: false, error: 'invalid_args' })
  }
  const injected = await exported.resolveCustomerPromiseAction({ promiseId, status: 'fulfilled', allowTenantScope: true, tenantId: 'foreign-tenant' })
  assert.deepEqual(JSON.parse(JSON.stringify(injected)), { success: false, error: 'invalid_args' })
  console.log('OK customer promise UI: own/tenant scope, denied resolution, untrusted scope rejection, active default + history')
}
void main()

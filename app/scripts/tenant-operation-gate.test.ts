/**
 * Tenant-operation gate + cancel-flag poll unit tesztek.
 * Futtatás: npx tsx scripts/tenant-operation-gate.test.ts
 */
import assert from 'node:assert/strict'
import { pollCancelRequested } from '../src/lib/cancel-flag-poll'
import {
  evaluateTenantOperationGate,
  resolveWorkOwnerTenantId,
} from '../src/lib/tenant-operation-gate'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  OK  ${name}`))
    .catch((e: unknown) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

async function main() {
  console.log('tenant-operation-gate / cancel-flag-poll\n')

  await check('work-owner: ticket tenant elsőbbség', () => {
    assert.equal(resolveWorkOwnerTenantId('t-ticket', 't-agent'), 't-ticket')
    assert.equal(resolveWorkOwnerTenantId(null, 't-agent'), 't-agent')
    assert.equal(resolveWorkOwnerTenantId(null, null), null)
  })

  await check('platform munka → allowed', async () => {
    const gate = await evaluateTenantOperationGate({ tenants: undefined, gateTenantId: null })
    assert.equal(gate.allowed, true)
  })

  await check('tenant-repo hiányzik → fail-closed', async () => {
    const gate = await evaluateTenantOperationGate({
      tenants: undefined,
      gateTenantId: 'tenant-a',
    })
    assert.equal(gate.allowed, false)
    if (!gate.allowed) assert.equal(gate.tenantStatus, 'repo_missing')
  })

  await check('suspended → denied', async () => {
    const gate = await evaluateTenantOperationGate({
      tenants: {
        async findById() {
          return { status: 'suspended' }
        },
      },
      gateTenantId: 'tenant-a',
    })
    assert.equal(gate.allowed, false)
  })

  await check('active → allowed', async () => {
    const gate = await evaluateTenantOperationGate({
      tenants: {
        async findById() {
          return { status: 'active' }
        },
      },
      gateTenantId: 'tenant-a',
    })
    assert.equal(gate.allowed, true)
  })

  await check('cancel poll: sikeres olvasás', async () => {
    const value = await pollCancelRequested({
      read: async () => true,
      previous: false,
    })
    assert.equal(value, true)
  })

  await check('cancel poll: hiba után previous megmarad', async () => {
    const value = await pollCancelRequested({
      read: async () => {
        throw new Error('db down')
      },
      previous: true,
    })
    assert.equal(value, true)
  })

  await check('cancel poll: retry sikerül', async () => {
    let calls = 0
    const value = await pollCancelRequested({
      read: async () => {
        calls++
        if (calls === 1) throw new Error('transient')
        return true
      },
      previous: false,
    })
    assert.equal(value, true)
    assert.equal(calls, 2)
  })

  console.log(failures === 0 ? '\nAll passed' : `\n${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()

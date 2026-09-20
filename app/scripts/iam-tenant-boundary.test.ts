/**
 * IAM tenant-boundary regression tests.
 *
 * Futtatás: DATABASE_URL=postgresql://stub:stub@127.0.0.1:5432/stub tsx scripts/iam-tenant-boundary.test.ts
 *
 * A teszt DB nélkül fut: az action-rétegből kiemelt access-audit szűrőt és az
 * IamService permission-update audit attribúcióját ellenőrzi.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildTenantAccessAuditFilter } from '../src/domain/iam/access-audit'
import { IamService } from '../src/domain/iam/iam-service'

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
  await check('access audit filter is tenant-scoped', () => {
    const filter = buildTenantAccessAuditFilter({ tenantId: 'tenant-a', limit: 25 })
    assert.equal(filter.tenantId, 'tenant-a')
    assert.equal(filter.limit, 25)
    assert.ok(Array.isArray(filter.action))
    assert.ok(filter.action.includes('user.authz.deny'))
    assert.ok(filter.action.includes('user.permission.update'))
  })

  await check('permission update writes user.permission.update', async () => {
    const events: Array<{ action: string; tenantId?: string | null }> = []
    const service = new IamService(
      {} as never,
      {} as never,
      {
        async findByKey(permissionKey: string) {
          assert.equal(permissionKey, 'audit.read')
          return {
            id: 'rp-existing',
            permissionKey,
            minRole: 'approver',
            description: 'Access audit olvasása',
            updatedAt: new Date('2026-01-01T00:00:00Z'),
          }
        },
        async findAll() {
          return []
        },
        async upsert(permissionKey: string, minRole: 'admin' | 'approver' | 'operator' | 'viewer', description?: string | null) {
          return {
            id: 'rp-updated',
            permissionKey,
            minRole,
            description: description ?? null,
            updatedAt: new Date('2026-01-02T00:00:00Z'),
          }
        },
      } as never,
      undefined,
      undefined,
      {
        async append(data) {
          events.push({ action: data.action, tenantId: data.tenantId })
        },
      },
    )

    const updated = await service.updatePermission({
      permissionKey: 'audit.read',
      minRole: 'admin',
      actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    })
    assert.equal(updated.minRole, 'admin')
    assert.equal(updated.id, 'rp-updated')
    assert.equal(events.length, 1)
    assert.equal(events[0].action, 'user.permission.update')
    assert.equal(events[0].tenantId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  })

  await check('agent access update writes user.agent_access.update', async () => {
    const events: Array<{ action: string; outputRef?: string | null; policyDecision?: string | null }> = []
    const service = new IamService(
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      {
        async append(data) {
          events.push({
            action: data.action,
            outputRef: data.outputRef,
            policyDecision: data.policyDecision,
          })
        },
      },
    )

    await service.auditUserAgentAccessUpdate({
      actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      targetUserId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      agentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      granted: true,
    })
    assert.equal(events.length, 1)
    assert.equal(events[0].action, 'user.agent_access.update')
    assert.equal(events[0].outputRef, 'operate')
    assert.equal(events[0].policyDecision, 'granted')
  })

  await check('role-write kapu: a platform-actionök a seedelt user.role.write kulcsot kérik', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/app/actions/platform.ts'), 'utf8')
    assert.equal(src.includes("requireTenantPermission('user.role.change')"), false)
    assert.ok(src.includes("requireTenantPermission('user.role.write')"))
  })

  console.log(`\n${failures === 0 ? 'Minden teszt zöld.' : `${failures} teszt bukott.`}`)
  if (failures > 0) process.exit(1)
}

main()

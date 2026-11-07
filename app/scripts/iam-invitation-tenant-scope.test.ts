/**
 * IAM meghívólista tenant-szigetelés regresszió.
 *
 * Futtatás: npm run test:iam-invitation-tenant-scope
 *
 * A control-plane `listInvitations` a hívó activeTenantId-jét adja át. Ha a
 * repository / szolgáltatás nem szűr tenantId-re, idegen cégek meghívó e-mailjei
 * és szerepei kiszivárognak.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Invitation } from '@prisma/client'
import { IamService } from '../src/domain/iam/iam-service'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.error(`  FAIL ${name}:`, error)
  }
}

function invite(partial: Partial<Invitation> & Pick<Invitation, 'id' | 'tenantId' | 'email'>): Invitation {
  const now = new Date('2026-10-15T00:00:00Z')
  return {
    role: 'operator',
    status: 'pending',
    tokenHash: `hash-${partial.id}`,
    expiresAt: new Date('2026-10-22T00:00:00Z'),
    createdById: 'admin-a',
    redeemedAt: null,
    revokedAt: null,
    clerkInvitationId: null,
    createdAt: now,
    updatedAt: now,
    ...partial,
  } as Invitation
}

async function main() {
  await check('listInvitations returns only the caller tenant rows', async () => {
    const seenFilters: Array<{ tenantId?: string | null }> = []
    const service = new IamService(
      {} as never,
      {
        async findMany(filter?: { tenantId?: string | null }) {
          seenFilters.push({ tenantId: filter?.tenantId })
          // Szándékosan rossz repo: mindkét tenantot visszaadja — a szolgáltatásnak
          // akkor is szűrnie kell (és a postgres fix után a filter is eljut).
          return [
            invite({ id: 'inv-a', tenantId: 'tenant-a', email: 'alice@a.example' }),
            invite({ id: 'inv-b', tenantId: 'tenant-b', email: 'bob@b.example' }),
          ]
        },
      } as never,
      {} as never,
    )

    const rows = await service.listInvitations('tenant-a', { limit: 100 })
    assert.deepEqual(
      rows.map((row) => row.id),
      ['inv-a'],
    )
    assert.equal(rows[0]?.email, 'alice@a.example')
    assert.deepEqual(seenFilters, [{ tenantId: 'tenant-a' }])
  })

  await check('listInvitations with null tenantId keeps only platform (null) invites', async () => {
    const service = new IamService(
      {} as never,
      {
        async findMany() {
          return [
            invite({ id: 'inv-platform', tenantId: null, email: 'ops@platform.example' }),
            invite({ id: 'inv-tenant', tenantId: 'tenant-a', email: 'alice@a.example' }),
          ]
        },
      } as never,
      {} as never,
    )

    const rows = await service.listInvitations(null, { unbounded: true })
    assert.deepEqual(
      rows.map((row) => row.id),
      ['inv-platform'],
    )
  })

  await check('postgres invitation findMany applies tenantId in the where clause', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/repositories/postgres/iam-repository.ts'), 'utf8')
    const findManyBlock = src.slice(src.indexOf('export class PostgresInvitationRepository'))
    assert.ok(
      /tenantId\s*!==\s*undefined\s*\?\s*\{\s*tenantId:\s*filter\.tenantId/.test(findManyBlock),
      'PostgresInvitationRepository.findMany must put tenantId into the Prisma where',
    )
  })

  console.log(`\n${failures === 0 ? 'Minden teszt zöld.' : `${failures} teszt bukott.`}`)
  if (failures > 0) process.exit(1)
}

main()

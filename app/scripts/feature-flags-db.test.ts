/**
 * #1126 fokozatos bevezetés valódi (migrált) Postgresen: állapot + audit egy tranzakcióban, version-ütközés,
 * sértetlen audit-lánc párhuzamos módosítások után, audit-kiesés, cég törlése, egy lekérdezéses betöltés.
 * Futtatás: npm run test:feature-flags-db (DATABASE_URL + DIRECT_URL egy eldobható DB-re).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { PlatformRole } from '@prisma/client'
import { AuditChainService } from '../src/domain/audit/audit-chain-service'
import { FeatureFlagAdminService, featureFlagSnapshotOf, type FeatureFlagStore } from '../src/domain/feature-flags/admin-service'
import { createFeatureFlagEvaluator } from '../src/domain/feature-flags/evaluator'
import type { FeatureFlagDefinition } from '../src/domain/feature-flags/registry'
import { prisma } from '../src/lib/db'
import { PostgresAuditRepository } from '../src/repositories/postgres/audit-repository'
import { PostgresFeatureFlagRepository } from '../src/repositories/postgres/feature-flag-repository'

const definition: FeatureFlagDefinition = {
  title: { hu: 'Próba', en: 'Test' },
  whatChanges: { hu: 'Új', en: 'New' },
  whenOff: { hu: 'Régi', en: 'Old' },
  owner: 'Teszt',
  issue: 1126,
  reviewBy: '2027-01-01',
}

const superadmin = { id: randomUUID(), platformRoles: ['superadmin'] as PlatformRole[] }

async function main() {
  const suffix = randomUUID().slice(0, 8)
  const KEY = `test_${suffix}.feature`
  const PARALLEL_KEYS = Array.from({ length: 6 }, (_, i) => `test_${suffix}.parallel_${i}`)
  const registry = Object.fromEntries([KEY, ...PARALLEL_KEYS].map((key) => [key, definition]))
  const [alfa, beta, doomed] = await Promise.all(
    ['alfa', 'beta', 'doomed'].map((name) =>
      prisma.tenant.create({ data: { slug: `flag-${name}-${suffix}`, displayName: `Flag ${name}` } }),
    ),
  )
  const refs = [alfa, beta].map(({ id, displayName }) => ({ id, displayName }))
  const makeService = (store: FeatureFlagStore) =>
    new FeatureFlagAdminService({ registry, store, listTenants: async () => refs, onChanged: () => undefined })
  const repo = new PostgresFeatureFlagRepository()
  const service = makeService(repo)
  const audit = new PostgresAuditRepository()
  const firstSeq = (await prisma.auditLog.aggregate({ _max: { seq: true } }))._max.seq ?? BigInt(0)

  try {
    const missing = await repo.find(KEY)
    assert.equal(missing, null)
    const reader = createFeatureFlagEvaluator({ load: async () => featureFlagSnapshotOf(await repo.loadAll()) })
    assert.equal(await reader.isEnabled(KEY, { tenantId: alfa.id }), false)
    console.log('  OK  sor nélkül a flag Ki, adatbetöltés nem kell')

    const first = await service.apply({
      key: KEY,
      expectedVersion: 0,
      mode: 'selected',
      tenantAccess: [{ tenantId: alfa.id, access: 'included' }],
      justification: 'saját cég',
      actor: superadmin,
    })
    assert.equal(first.status, 'applied')
    const row = await repo.find(KEY)
    assert.equal(row?.version, 1)
    assert.equal(row?.mode, 'selected')
    assert.deepEqual(row?.tenants, [{ tenantId: alfa.id, access: 'included' }])
    reader.invalidate()
    assert.equal(await reader.isEnabled(KEY, { tenantId: alfa.id }), true)
    assert.equal(await reader.isEnabled(KEY, { tenantId: beta.id }), false)
    console.log('  OK  kiválasztott cégnél aktív, a másiknál nem')

    const tenantRows = await prisma.auditLog.findMany({ where: { tenantId: alfa.id, targetType: 'feature_flag' } })
    assert.equal(tenantRows.length, 1)
    assert.deepEqual(tenantRows[0].metadata, { flagKey: KEY, flagTitle: definition.title, active: true })
    assert.equal(await prisma.auditLog.count({ where: { tenantId: beta.id, targetType: 'feature_flag' } }), 0)
    const history = await repo.listHistory(KEY, 10)
    assert.deepEqual(history.map((entry) => entry.action).sort(), ['platform.feature_flag.mode_set', 'platform.feature_flag.tenant_access_set'])
    assert.equal((history[0].metadata as { justification: string }).justification, 'saját cég')
    console.log('  OK  platform-előzmény indoklással, a cég naplójában csak név és állapot')

    const racers = await Promise.all(
      ['egyik', 'másik'].map((justification) =>
        service.apply({ key: KEY, expectedVersion: 1, tenantAccess: [{ tenantId: beta.id, access: 'included' }], justification, actor: superadmin }),
      ),
    )
    assert.deepEqual(racers.map((r) => r.status).sort(), ['applied', 'conflict'])
    assert.equal((await repo.find(KEY))?.version, 2)
    assert.equal((await repo.listHistory(KEY, 10)).filter((e) => e.action === 'platform.feature_flag.tenant_access_set').length, 2)
    console.log('  OK  két admin egyszerre: egy nyer, a másik ütközést kap, nincs dupla audit')

    const creators = await Promise.all(
      [1, 2].map(() => service.apply({ key: PARALLEL_KEYS[0], expectedVersion: 0, mode: 'selected', justification: 'első sor', actor: superadmin })),
    )
    assert.deepEqual(creators.map((r) => r.status).sort(), ['applied', 'conflict'])
    console.log('  OK  a még nem létező sor létrehozásánál is egy nyer')

    let auditCalls = 0
    const brokenAudit = new PostgresFeatureFlagRepository(async () => {
      auditCalls += 1
      throw new Error('audit down')
    })
    const broken = makeService(brokenAudit)
    assert.equal(
      (await broken.apply({ key: PARALLEL_KEYS[1], expectedVersion: 0, mode: 'selected', tenantAccess: [{ tenantId: alfa.id, access: 'included' }], justification: 'bővítés', actor: superadmin })).status,
      'audit_failed',
    )
    assert.equal(await repo.find(PARALLEL_KEYS[1]), null, 'a sikertelen audit a flag sorát is visszagörgeti')
    const auditRowsBefore = await prisma.auditLog.count({ where: { targetType: 'feature_flag' } })
    const stopped = await broken.apply({ key: KEY, expectedVersion: 2, mode: 'off', justification: 'hiba', actor: superadmin })
    assert.deepEqual(stopped.status === 'applied' && stopped.auditFailed, true)
    assert.equal((await repo.find(KEY))?.mode, 'off')
    assert.equal(await prisma.auditLog.count({ where: { targetType: 'feature_flag' } }), auditRowsBefore)
    assert.ok(auditCalls >= 2)
    console.log('  OK  audit-kiesés: a bővítés visszagörgetve, a leállítás érvényesül')

    const stoppedRow = await repo.find(KEY)
    assert.equal(stoppedRow?.tenants.length, 2)
    assert.ok(stoppedRow?.stoppedAt)
    console.log('  OK  leállítás után a cégek listája megmarad')

    const parallel = await Promise.all(
      PARALLEL_KEYS.slice(1).map((key) =>
        service.apply({ key, expectedVersion: 0, mode: 'all', tenantAccess: [{ tenantId: alfa.id, access: 'excluded' }], justification: 'párhuzamos', actor: superadmin }),
      ),
    )
    assert.ok(parallel.every((r) => r.status === 'applied'))
    assert.ok((await repo.find(PARALLEL_KEYS[1]))?.removeBy)
    const chain = await new AuditChainService(audit).verifyChain(firstSeq + BigInt(1))
    assert.equal(chain.ok, true, JSON.stringify(chain, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
    console.log(`  OK  az audit-lánc sértetlen párhuzamos módosítások után (${chain.checked} sor)`)

    const tenantChain = await new AuditChainService(audit).verifyChain(undefined, undefined, alfa.id)
    assert.equal(tenantChain.ok, true)
    const fullChain = await audit.findMany({ targetType: 'feature_flag', tenantId: beta.id, limit: 50 })
    assert.ok(fullChain.length >= 1)
    assert.ok(fullChain.every((entry) => !JSON.stringify(entry.metadata).includes('justification')))
    console.log('  OK  a cég naplójában nincs indoklás')

    let queries = 0
    const counting = createFeatureFlagEvaluator({
      load: async () => {
        queries += 1
        return featureFlagSnapshotOf(await repo.loadAll())
      },
    })
    await Promise.all(Object.keys(registry).map((key) => counting.isEnabled(key, { tenantId: alfa.id })))
    assert.equal(queries, 1)
    console.log('  OK  egy oldalmegnyitás nem kérdez flagenként')

    await prisma.featureFlagTenant.create({ data: { flagKey: KEY, tenantId: doomed.id, access: 'included' } })
    await prisma.tenant.delete({ where: { id: doomed.id } })
    assert.equal(await prisma.featureFlagTenant.count({ where: { tenantId: doomed.id } }), 0)
    assert.ok(await repo.find(KEY))
    console.log('  OK  cég törlésekor a sora is törlődik, a flag megmarad')

    console.log('\nfeature-flags-db: ok')
  } finally {
    await prisma.featureFlag.deleteMany({ where: { key: { startsWith: `test_${suffix}.` } } })
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

/**
 * `surrogate_map` DB-invariánsok (AI Privacy Gateway APG-01 / spec §5–§6, D2).
 *
 * VALÓDI Postgres kell hozzá — a bijektivitást a unique kényszerek kényszerítik ki,
 * a párhuzamos allokáció pedig csak akkor konvergál, ha a unique ütközés után
 * újraolvasás történik, nem második insert.
 *
 * Futtatás egy migrált DB ellen:
 *   npm run test:surrogate-map
 * A CI-ban a `migrations` job futtatja, közvetlenül a `prisma migrate deploy` után.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { allocateRefSurrogate } from '../src/domain/privacy/allocate-ref-surrogate'
import { formatSurrogate } from '../src/domain/privacy/surrogate-format'
import { PostgresSurrogateVault } from '../src/domain/privacy/surrogate-vault'

let failures = 0
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const HMAC = '0'.repeat(64)

async function withTenant(fn: (tenantId: string) => Promise<void>) {
  const suffix = randomUUID().slice(0, 8)
  const tenant = await prisma.tenant.create({
    data: { slug: `smap-${suffix}`, displayName: `surrogate-map ${suffix}` },
  })
  try {
    await fn(tenant.id)
  } finally {
    await prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => undefined)
  }
}

function refInput(tenantId: string, overrides: Record<string, string> = {}) {
  return {
    tenantId,
    scopeType: 'conversation' as const,
    scopeId: randomUUID(),
    entityType: 'company',
    surrogate: '[[COMPANY_1]]',
    connectorId: randomUUID(),
    sourceId: 'crm/company/4821',
    hmac: HMAC,
    ...overrides,
  }
}

async function main() {
  console.log('surrogate_map DB-invariánsok\n')

  await check('ugyanaz az entitás második allokációja a meglévő álnevet adja, nem újat', async () => {
    await withTenant(async (tenantId) => {
      const input = refInput(tenantId)
      const first = await allocateRefSurrogate(input)
      const second = await allocateRefSurrogate({ ...input, surrogate: '[[COMPANY_99]]' })
      assert.equal(first.surrogate, '[[COMPANY_1]]')
      assert.equal(second.surrogate, '[[COMPANY_1]]')
      assert.equal(first.id, second.id)
      const count = await prisma.surrogateMap.count({
        where: { tenantId, scopeId: input.scopeId },
      })
      assert.equal(count, 1)
    })
  })

  await check('két párhuzamos allokáció ugyanarra az entitásra egy sort és egy álnevet ad', async () => {
    await withTenant(async (tenantId) => {
      const input = refInput(tenantId)
      const results = await Promise.all(
        Array.from({ length: 8 }, () => allocateRefSurrogate(input)),
      )
      const surrogates = new Set(results.map((row) => row.surrogate))
      const ids = new Set(results.map((row) => row.id))
      assert.equal(surrogates.size, 1)
      assert.equal(ids.size, 1)
      assert.equal([...surrogates][0], '[[COMPANY_1]]')
      const count = await prisma.surrogateMap.count({
        where: { tenantId, scopeId: input.scopeId },
      })
      assert.equal(count, 1)
    })
  })

  await check('egy scope-on belül két entitás nem kaphatja ugyanazt az álnevet', async () => {
    await withTenant(async (tenantId) => {
      const scopeId = randomUUID()
      await allocateRefSurrogate(refInput(tenantId, { scopeId, sourceId: 'crm/company/1' }))
      await assert.rejects(() =>
        allocateRefSurrogate(
          refInput(tenantId, {
            scopeId,
            sourceId: 'crm/company/2',
            connectorId: randomUUID(),
          }),
        ),
      )
    })
  })

  await check('CHECK: ref-osztály nem tárolhat titkosított értéket', async () => {
    await withTenant(async (tenantId) => {
      await assert.rejects(() =>
        prisma.surrogateMap.create({
          data: {
            tenantId,
            scopeType: 'conversation',
            scopeId: randomUUID(),
            entityType: 'company',
            surrogate: '[[COMPANY_1]]',
            class: 'ref',
            connectorId: randomUUID(),
            sourceId: 'crm/company/4821',
            encryptedValue: 'should-not-store',
            hmac: HMAC,
          },
        }),
      )
    })
  })

  await check('val-osztály mezői üresen is létrehozhatók (APG-19 tölti)', async () => {
    await withTenant(async (tenantId) => {
      const row = await prisma.surrogateMap.create({
        data: {
          tenantId,
          scopeType: 'trace',
          scopeId: randomUUID(),
          entityType: 'email',
          surrogate: '[[EMAIL_1]]',
          class: 'val',
          hmac: HMAC,
        },
      })
      assert.equal(row.class, 'val')
      assert.equal(row.encryptedValue, null)
      assert.equal(row.connectorId, null)
      assert.equal(row.sourceId, null)
    })
  })

  await check('APG-10: insertRefs N entitást egy tranzakcióban ír, ütköző entitás a meglévőt adja', async () => {
    await withTenant(async (tenantId) => {
      const vault = new PostgresSurrogateVault(() => 'test-tenant-hmac-key')
      const scope = { type: 'conversation' as const, id: randomUUID() }
      const connectorId = randomUUID()
      const inputs = Array.from({ length: 20 }, (_, i) => ({
        tenantId,
        scope,
        entityType: 'company',
        connectorId,
        sourceId: `crm/company/${i + 1}`,
        surrogate: formatSurrogate('company', i + 1),
      }))
      const first = await vault.insertRefs(inputs)
      assert.equal(first.length, 20)
      const again = await vault.insertRefs(inputs)
      assert.equal(again.length, 20)
      assert.equal(again[0]?.surrogate, '[[COMPANY_1]]')
      assert.equal(again[0]?.id, first[0]?.id)
      const count = await prisma.surrogateMap.count({
        where: { tenantId, scopeId: scope.id },
      })
      assert.equal(count, 20)
    })
  })

  console.log(failures === 0 ? '\nMinden surrogate_map teszt zöld.' : `\n${failures} teszt elbukott.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

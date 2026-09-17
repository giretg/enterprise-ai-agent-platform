/**
 * A runtime Prisma-kliens Neon pooled connection stringje serverless-hangolt legyen:
 *  - alacsony `connection_limit` (a pooled kapcsolatok forogjanak, ne reapelje őket
 *    a Neon pooler idle-timeoutja → kevesebb `kind: Closed` hiba),
 *  - `pgbouncer=true` a `-pooler` végponton (prepared-statement ütközés elkerülése),
 *  - a connection stringben már megadott értéket SOHA nem írjuk felül,
 *  - a direkt (migrációs) végpont érintetlen marad.
 *
 * Futtatás: npx tsx scripts/prisma-pool-config.test.ts
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const POOLED = 'postgresql://user:pw@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require'
const DIRECT = 'postgresql://user:pw@ep-cool-name-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require'

async function load() {
  return import('../src/lib/database-mode')
}

test('a pooled Neon végpont serverless connection-limitet kap (alapból 5, nem a régi 10)', async () => {
  const { applyPoolDefaults } = await load()
  const out = new URL(applyPoolDefaults(POOLED))
  const limit = Number(out.searchParams.get('connection_limit'))
  assert.ok(Number.isFinite(limit), 'connection_limit be van állítva')
  assert.ok(limit <= 5, `connection_limit legyen <= 5 (kapott: ${limit})`)
  assert.equal(out.searchParams.get('pool_timeout'), '20')
  assert.equal(out.searchParams.get('connect_timeout'), '10')
})

test('a -pooler végpont megkapja a pgbouncer=true flaget', async () => {
  const { applyPoolDefaults } = await load()
  const out = new URL(applyPoolDefaults(POOLED))
  assert.equal(out.searchParams.get('pgbouncer'), 'true')
  // az sslmode nem veszik el
  assert.equal(out.searchParams.get('sslmode'), 'require')
})

test('a direkt (migrációs) végpont NEM kap pgbouncer flaget', async () => {
  const { applyPoolDefaults } = await load()
  const out = new URL(applyPoolDefaults(DIRECT))
  assert.equal(out.searchParams.has('pgbouncer'), false, 'direkt végponton nincs PgBouncer')
})

test('a connection stringben megadott értéket sosem írjuk felül', async () => {
  const { applyPoolDefaults } = await load()
  const explicit = POOLED + '&connection_limit=25&pgbouncer=false&pool_timeout=45'
  const out = new URL(applyPoolDefaults(explicit))
  assert.equal(out.searchParams.get('connection_limit'), '25', 'explicit limit marad')
  assert.equal(out.searchParams.get('pgbouncer'), 'false', 'explicit pgbouncer marad')
  assert.equal(out.searchParams.get('pool_timeout'), '45', 'explicit pool_timeout marad')
})

test('nem parse-olható URL változatlanul jön vissza', async () => {
  const { applyPoolDefaults } = await load()
  assert.equal(applyPoolDefaults('not-a-url'), 'not-a-url')
})

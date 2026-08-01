/**
 * HTTP API lapozás (http_api_get_all) unit tesztek.
 * Futtatás: npx tsx scripts/http-api-paginate.test.ts
 */
import assert from 'node:assert/strict'
import {
  buildPageQuery,
  extractPageItems,
  paginateHttpApiGet,
  resolveHttpApiPaginatePlan,
} from '../src/domain/connector/http-api-paginate'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✅ ${name}`))
    .catch((e) => {
      failures++
      console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

async function main() {
  console.log('\n=== http-api-paginate ===\n')

  await check('extractPageItems: root tömb', () => {
    assert.deepEqual(extractPageItems([{ id: 1 }]), [{ id: 1 }])
  })

  await check('extractPageItems: ownerships burkoló', () => {
    assert.equal(extractPageItems({ ownerships: [{ a: 1 }, { a: 2 }] })?.length, 2)
  })

  await check('extractPageItems: arrayPath', () => {
    assert.deepEqual(extractPageItems({ data: { rows: [1, 2] } }, 'data.rows'), [1, 2])
  })

  await check('buildPageQuery összefésüli a page paramokat', () => {
    assert.deepEqual(
      buildPageQuery({ search: 'x' }, { pageParam: 'page', pageSizeParam: 'pageSize', pageSize: 50 }, 3),
      { search: 'x', page: 3, pageSize: 50 },
    )
  })

  await check('paginate: 3 oldal → összevont items, short last page stops', async () => {
    const pages = [
      { ok: true, status: 200, body: Array.from({ length: 100 }, (_, i) => ({ id: i })) },
      { ok: true, status: 200, body: Array.from({ length: 100 }, (_, i) => ({ id: 100 + i })) },
      { ok: true, status: 200, body: Array.from({ length: 47 }, (_, i) => ({ id: 200 + i })) },
    ]
    let calls = 0
    const outcome = await paginateHttpApiGet({
      plan: resolveHttpApiPaginatePlan({ pageSize: 100, maxPages: 10 }),
      fetchPage: async () => pages[calls++]!,
    })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.pageCount, 3)
    assert.equal(outcome.items.length, 247)
    assert.equal(outcome.paginationComplete, true)
    assert.equal(calls, 3)
  })

  await check('paginate: üres oldal → stop', async () => {
    const outcome = await paginateHttpApiGet({
      plan: resolveHttpApiPaginatePlan({ pageSize: 10 }),
      fetchPage: async () => ({ ok: true, status: 200, body: [] }),
    })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.pageCount, 1)
    assert.equal(outcome.items.length, 0)
    assert.equal(outcome.paginationComplete, true)
  })

  await check('paginate: maxPages teljes lap után → nem igazoltan teljes', async () => {
    const outcome = await paginateHttpApiGet({
      plan: resolveHttpApiPaginatePlan({ pageSize: 2, maxPages: 1 }),
      fetchPage: async () => ({ ok: true, status: 200, body: [{ id: 1 }, { id: 2 }] }),
    })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.paginationComplete, false)
  })

  await check('paginate: HTTP hiba → failure a gyűjtött items-szel', async () => {
    let n = 0
    const outcome = await paginateHttpApiGet({
      plan: resolveHttpApiPaginatePlan({ pageSize: 2, maxPages: 5 }),
      fetchPage: async () => {
        n += 1
        if (n === 1) return { ok: true, status: 200, body: [{ id: 1 }, { id: 2 }] }
        return { ok: false, status: 500, body: { error: 'boom' } }
      },
    })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.items.length, 2)
    assert.match(outcome.error, /500/)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott\n`)
    process.exit(1)
  }
  console.log('\n✅ Minden teszt zöld\n')
}

main()

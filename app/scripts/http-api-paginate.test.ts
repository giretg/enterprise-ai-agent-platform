/**
 * HTTP API lapozás (http_api_get_all) unit tesztek.
 * Futtatás: npx tsx scripts/http-api-paginate.test.ts
 */
import assert from 'node:assert/strict'
import {
  buildPageQuery,
  extractPageItems,
  paginateHttpApiGet,
  paginationQueryParamNames,
  resolveHttpApiPaginatePlan,
  undocumentedPaginationQueryParams,
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

function pagePlan(input: { pageSize: number; maxPages?: number }) {
  const plan = resolveHttpApiPaginatePlan({
    pagination: {
      kind: 'page',
      pageParam: 'page',
      pageSizeParam: 'pageSize',
      firstPage: 1,
      itemsPath: '$',
    },
    ...input,
  })
  assert.ok(plan)
  return plan
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
      plan: pagePlan({ pageSize: 100, maxPages: 10 }),
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
      plan: pagePlan({ pageSize: 10 }),
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
      plan: pagePlan({ pageSize: 2, maxPages: 1 }),
      fetchPage: async () => ({ ok: true, status: 200, body: [{ id: 1 }, { id: 2 }] }),
    })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.paginationComplete, false)
  })

  await check('paginate: HTTP hiba → failure a gyűjtött items-szel', async () => {
    let n = 0
    const outcome = await paginateHttpApiGet({
      plan: pagePlan({ pageSize: 2, maxPages: 5 }),
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

  await check('paginate: cursor a válasz meta.nextCursor értékét küldi tovább', async () => {
    const queries: Array<Record<string, string | number | boolean>> = []
    const outcome = await paginateHttpApiGet({
      plan: {
        kind: 'cursor',
        cursorParam: 'cursor',
        limitParam: 'limit',
        pageSize: 2,
        itemsPath: 'data',
        nextCursorPath: 'meta.nextCursor',
        maxPages: 10,
      },
      baseQuery: { status: 'ACTIVE' },
      fetchPage: async (query) => {
        queries.push(query)
        return queries.length === 1
          ? { ok: true, status: 200, body: { data: [{ id: 1 }, { id: 2 }], meta: { total: 3, nextCursor: 'c-2' } } }
          : { ok: true, status: 200, body: { data: [{ id: 3 }], meta: { total: 3, nextCursor: null } } }
      },
    })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.paginationComplete, true)
    assert.equal(outcome.stopReason, 'next_cursor_absent')
    assert.equal(outcome.items.length, 3)
    assert.deepEqual(queries, [
      { status: 'ACTIVE', limit: 2 },
      { status: 'ACTIVE', limit: 2, cursor: 'c-2' },
    ])
  })

  await check('paginate: numerikus cursor nem minősül hiányzó folytatásnak', async () => {
    const queries: Array<Record<string, string | number | boolean>> = []
    const outcome = await paginateHttpApiGet({
      plan: {
        kind: 'cursor', cursorParam: 'after_id', itemsPath: 'data',
        nextCursorPath: 'next_id', pageSize: 100, maxPages: 5,
      },
      fetchPage: async (query) => {
        queries.push(query)
        return queries.length === 1
          ? { ok: true, status: 200, body: { data: [{ id: 1 }], next_id: 2 } }
          : { ok: true, status: 200, body: { data: [{ id: 2 }], next_id: null } }
      },
    })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.items.length, 2)
    assert.deepEqual(queries, [{}, { after_id: 2 }])
  })

  await check('paginate: offset/limit a ténylegesen összegyűjtött elemszámmal lép', async () => {
    const queries: Array<Record<string, string | number | boolean>> = []
    const outcome = await paginateHttpApiGet({
      plan: {
        kind: 'offset', offsetParam: 'offset', limitParam: 'limit',
        firstOffset: 0, itemsPath: 'items', pageSize: 2, maxPages: 5,
      },
      fetchPage: async (query) => {
        queries.push(query)
        return queries.length === 1
          ? { ok: true, status: 200, body: { items: [{ id: 1 }, { id: 2 }] } }
          : { ok: true, status: 200, body: { items: [{ id: 3 }] } }
      },
    })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.stopReason, 'short_page')
    assert.deepEqual(queries, [{ offset: 0, limit: 2 }, { offset: 2, limit: 2 }])
  })

  await check('paginate: RFC 8288 Link rel=next query-jét követi', async () => {
    const queries: Array<Record<string, string | number | boolean>> = []
    const outcome = await paginateHttpApiGet({
      plan: {
        kind: 'next_link', linkHeaderRel: 'next', itemsPath: 'results',
        pageSize: 100, maxPages: 5,
      },
      path: '/search',
      baseQuery: { q: 'wine' },
      fetchPage: async (query) => {
        queries.push(query)
        return queries.length === 1
          ? {
              ok: true, status: 200, body: { results: [{ id: 1 }] },
              linkHeader: '</search?q=wine&after=a2>; rel="next"',
            }
          : { ok: true, status: 200, body: { results: [{ id: 2 }] } }
      },
    })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.stopReason, 'next_link_absent')
    assert.deepEqual(queries, [{ q: 'wine' }, { q: 'wine', after: 'a2' }])
  })

  await check('paginate: body nextLink mező query-jét követi', async () => {
    const queries: Array<Record<string, string | number | boolean>> = []
    const outcome = await paginateHttpApiGet({
      plan: {
        kind: 'next_link', nextLinkPath: 'paging.next', itemsPath: 'records',
        pageSize: 100, maxPages: 5,
      },
      path: '/records',
      fetchPage: async (query) => {
        queries.push(query)
        return queries.length === 1
          ? {
              ok: true, status: 200,
              body: { records: [{ id: 1 }], paging: { next: '/records?continuation=next-2' } },
            }
          : { ok: true, status: 200, body: { records: [{ id: 2 }], paging: { next: null } } }
      },
    })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.stopReason, 'next_link_absent')
    assert.deepEqual(queries, [{}, { continuation: 'next-2' }])
  })

  await check('paginate: query-only és path-alapú next link is követhető', async () => {
    const requests: Array<{ path?: string; query: Record<string, string | number | boolean> }> = []
    const outcome = await paginateHttpApiGet({
      plan: {
        kind: 'next_link', linkHeaderRel: 'next', itemsPath: 'items',
        pageSize: 100, maxPages: 5,
      },
      baseUrl: 'https://api.example/v1',
      path: '/items',
      fetchPage: async (query, path) => {
        requests.push({ path, query })
        if (requests.length === 1) {
          return {
            ok: true, status: 200, body: { items: [{ id: 1 }] },
            linkHeader: '<?page=2>; rel="next"',
          }
        }
        if (requests.length === 2) {
          return {
            ok: true, status: 200, body: { items: [{ id: 2 }] },
            linkHeader: '</v1/items/page/3>; rel="next"',
          }
        }
        return { ok: true, status: 200, body: { items: [{ id: 3 }] } }
      },
    })
    assert.equal(outcome.ok, true)
    assert.deepEqual(requests, [
      { path: '/items', query: {} },
      { path: '/items', query: { page: '2' } },
      { path: '/items/page/3', query: {} },
    ])
  })

  await check('paginate: explicit nem lapozott endpoint egyetlen hívás után teljes', async () => {
    let calls = 0
    const outcome = await paginateHttpApiGet({
      plan: { kind: 'none', itemsPath: '$', pageSize: 100, maxPages: 5 },
      fetchPage: async () => {
        calls += 1
        return { ok: true, status: 200, body: [{ id: 1 }] }
      },
    })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.stopReason, 'not_paginated')
    assert.equal(outcome.paginationComplete, true)
    assert.equal(calls, 1)
  })

  await check('resolve: stratégia és explicit legacy pageParam nélkül nem talál ki paramétert', () => {
    assert.equal(resolveHttpApiPaginatePlan({ pageSize: 100, arrayPath: 'data' }), null)
  })

  await check('resolve: OpenAPI maxPageSize korlátozza a kért lapméretet', () => {
    const plan = resolveHttpApiPaginatePlan({
      pagination: {
        kind: 'offset', offsetParam: 'offset', limitParam: 'limit', itemsPath: 'items',
        firstOffset: 0, defaultPageSize: 25, maxPageSize: 50,
      },
      pageSize: 200,
    })
    assert.ok(plan)
    assert.equal(plan.pageSize, 50)
    assert.deepEqual(paginationQueryParamNames(plan), ['offset', 'limit'])
    assert.deepEqual(
      undocumentedPaginationQueryParams(plan, [{ name: 'cursor' }, { name: 'limit' }]),
      ['offset'],
    )
    const defaulted = resolveHttpApiPaginatePlan({
      pagination: {
        kind: 'offset', offsetParam: 'offset', limitParam: 'limit', itemsPath: 'items',
        firstOffset: 0, maxPageSize: 40,
      },
    })
    assert.ok(defaulted)
    assert.equal(defaulted.pageSize, 40)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott\n`)
    process.exit(1)
  }
  console.log('\n✅ Minden teszt zöld\n')
}

main()

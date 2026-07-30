/**
 * HTTP API prompt / katalógus / 4xx-hint / truncate — tiszta függvény tesztek.
 * Futtatás: npx tsx scripts/http-api-prompt.test.ts
 */
import assert from 'node:assert/strict'
import {
  buildHttpApiClientErrorHint,
  buildHttpApiEfficiencyGuidance,
  buildHttpApiTruncationBody,
  formatHttpApiEndpointCatalogSuffix,
  formatHttpApiQueryParamsHint,
} from '../src/domain/connector/http-api-prompt'
import { HttpApiClient, parseHttpApiConfig } from '../src/domain/connector/http-api-client'
import { formatLargeToolResultPreview } from '../src/domain/agent/tool-result-extract'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => {
      failures += 1
      console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
    })
}

async function main() {
  console.log('\n=== http-api-prompt ===\n')

  await check('parseHttpApiConfig megőrzi az OpenAPI query/path paramokat', () => {
    const config = parseHttpApiConfig({
      baseUrl: 'https://crm.example/api/v1',
      auth: { scheme: 'bearer' },
      endpoints: [
        {
          method: 'GET',
          path: '/reports/query',
          description: 'Aggregált riport',
          parameters: [
            { name: 'from', in: 'query', required: true, type: 'string', description: 'ISO dátum' },
            { name: 'to', in: 'query', required: true, type: 'string' },
            { name: 'dataset', in: 'query', required: false, type: 'string' },
            { name: 'accountId', in: 'path', required: true, type: 'string' },
            { name: 'X-Request-Id', in: 'header', required: false },
          ],
        },
      ],
    })
    const ep = config.endpoints?.[0]
    assert.ok(ep)
    assert.deepEqual(
      ep.queryParams?.map((p) => ({ name: p.name, required: p.required, type: p.type })),
      [
        { name: 'from', required: true, type: 'string' },
        { name: 'to', required: true, type: 'string' },
        { name: 'dataset', required: false, type: 'string' },
      ],
    )
    assert.equal(ep.pathParams?.[0]?.name, 'accountId')
    assert.deepEqual(ep.headerParams, [{ name: 'X-Request-Id', required: false }])
  })

  await check('parseHttpApiConfig elfogadja a kézi queryParams mezőt', () => {
    const config = parseHttpApiConfig({
      baseUrl: 'https://crm.example/api/v1',
      auth: { scheme: 'bearer' },
      endpoints: [
        {
          method: 'GET',
          path: '/orders',
          queryParams: [{ name: 'limit', required: false, type: 'integer' }],
        },
      ],
    })
    assert.deepEqual(config.endpoints?.[0].queryParams, [
      { name: 'limit', required: false, type: 'integer' },
    ])
  })

  await check('katalógus suffix tartalmazza a query paramokat', () => {
    const suffix = formatHttpApiEndpointCatalogSuffix({
      method: 'GET',
      path: '/orders',
      queryParams: [
        { name: 'from', required: true, type: 'string' },
        { name: 'limit', required: false, type: 'integer' },
      ],
      headerParams: [{ name: 'X-Request-Id', required: false }],
    })
    assert.match(suffix, /query: from:string, kötelező/)
    assert.match(suffix, /limit:integer/)
    assert.match(suffix, /Hívói fejlécek: X-Request-Id \(opcionális\)/)
  })

  await check('422 hint felsorolja az engedélyezett query-ket és az ismeretlen kulcsokat', () => {
    const hint = buildHttpApiClientErrorHint({
      status: 422,
      endpoint: {
        queryParams: [
          { name: 'from', required: true, type: 'string' },
          { name: 'to', required: true, type: 'string' },
        ],
      },
      usedQueryKeys: ['orderedAt_gte', 'from'],
    })
    assert.ok(hint)
    assert.match(hint!, /from:string, kötelező/)
    assert.match(hint!, /orderedAt_gte/)
    assert.match(hint!, /Ne tippelj/)
  })

  await check('422 hint dokumentált param nélkül is terel aggregációra', () => {
    const hint = buildHttpApiClientErrorHint({ status: 422, usedQueryKeys: ['foo'] })
    assert.ok(hint)
    assert.match(hint!, /Ne találj ki új query/)
    assert.match(hint!, /aggregált/)
  })

  await check('hatékonysági guidance analitikus / get_all / extract utat ír', () => {
    const text = buildHttpApiEfficiencyGuidance()
    assert.match(text, /http_api_get_all/)
    assert.match(text, /aggregált|report/i)
    assert.match(text, /tool_result_extract/)
    assert.match(text, /proxy-metrik/)
    assert.doesNotMatch(text, /CRM|Ostoros|HANSA/)
  })

  await check('JSON over maxResponseChars: soft hint, teljes body megmarad (get_all)', async () => {
    const huge = JSON.stringify({
      items: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `x${i}` })),
    })
    assert.ok(huge.length > 25_000)
    const fakeFetch: typeof fetch = async () =>
      new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } })
    const original = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const config = parseHttpApiConfig({
        baseUrl: 'https://crm.example/api/v1',
        auth: { scheme: 'bearer' },
        maxResponseChars: 5_000,
        endpoints: [{ method: 'GET', path: '/accounts' }],
      })
      const client = new HttpApiClient(config, 'key')
      const res = await client.request({ method: 'GET', path: '/accounts' })
      assert.equal(res.ok, true)
      assert.equal(res.truncated, true)
      assert.ok(res.hint)
      assert.match(res.hint!, /soft limit|megmaradt|get_all/i)
      const body = res.body as { items: unknown[] }
      assert.ok(Array.isArray(body.items))
      assert.equal(body.items.length, 5000)
    } finally {
      globalThis.fetch = original
    }
  })

  await check('parse-olhatatlan oversized JSON → hard truncate meta', async () => {
    const broken = '{"items":[' + 'x'.repeat(8_000)
    const fakeFetch: typeof fetch = async () =>
      new Response(broken, { status: 200, headers: { 'content-type': 'application/json' } })
    const original = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const config = parseHttpApiConfig({
        baseUrl: 'https://crm.example/api/v1',
        auth: { scheme: 'bearer' },
        maxResponseChars: 1_000,
        endpoints: [{ method: 'GET', path: '/accounts' }],
      })
      const client = new HttpApiClient(config, 'key')
      const res = await client.request({ method: 'GET', path: '/accounts' })
      assert.equal(res.truncated, true)
      const body = res.body as { truncated: true; preview: string }
      assert.equal(body.truncated, true)
      assert.ok(body.preview.length <= 1_000)
    } finally {
      globalThis.fetch = original
    }
  })

  await check('4xx válasz hintet kap a dokumentált query paramokkal', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'invalid query' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      })
    const original = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const config = parseHttpApiConfig({
        baseUrl: 'https://crm.example/api/v1',
        auth: { scheme: 'bearer' },
        endpoints: [
          {
            method: 'GET',
            path: '/orders',
            parameters: [
              { name: 'from', in: 'query', required: true, type: 'string' },
              { name: 'to', in: 'query', required: true, type: 'string' },
            ],
          },
        ],
      })
      const client = new HttpApiClient(config, 'key')
      const res = await client.request({
        method: 'GET',
        path: '/orders',
        query: { orderedAt_gte: '2025-01-01', limit: 100 },
      })
      assert.equal(res.ok, false)
      assert.equal(res.status, 422)
      assert.ok(res.hint)
      assert.match(res.hint!, /from:string/)
      assert.match(res.hint!, /orderedAt_gte/)
    } finally {
      globalThis.fetch = original
    }
  })

  await check('nagy eredmény előnézete arrayPath tippet ad nestelt body.data-hoz', () => {
    const preview = formatLargeToolResultPreview({
      archivePath: '.tool-results/01-http_api_get-crm.json',
      workspacePath: 'tool-outputs/01-http_api_get-crm.json',
      chars: 80_000,
      bytes: 82_000,
      previewText: JSON.stringify({
        status: 200,
        ok: true,
        body: { data: [{ id: 1, name: 'A' }] },
      }),
    })
    assert.match(preview, /arrayPath tipp: body\.data/)
    assert.match(preview, /tool_result_extract/)
  })

  await check('csonka preview szövegből is arrayPath tipp (body.data)', () => {
    const preview = formatLargeToolResultPreview({
      archivePath: '.tool-results/01-http_api_get-crm.json',
      workspacePath: 'tool-outputs/01-http_api_get-crm.json',
      chars: 80_000,
      bytes: 82_000,
      previewText: '{"status":200,"ok":true,"body":{"data":[{"id":1,"name":"A"',
    })
    assert.match(preview, /arrayPath tipp: body\.data/)
  })

  await check('truncation body tartalmaz actionable hintet', () => {
    const body = buildHttpApiTruncationBody({
      originalChars: 2_000_000,
      maxChars: 20_000,
      preview: '{"a":1',
    })
    assert.equal(body.truncated, true)
    assert.match(body.hint, /http_api_get_all/)
    assert.match(body.hint, /tool_result_extract/)
  })

  await check('query hint formázás üres listánál üres string', () => {
    assert.equal(formatHttpApiQueryParamsHint(undefined), '')
    assert.equal(formatHttpApiQueryParamsHint([]), '')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott\n`)
    process.exit(1)
  }
  console.log('\n✅ Minden teszt zöld\n')
}

main()

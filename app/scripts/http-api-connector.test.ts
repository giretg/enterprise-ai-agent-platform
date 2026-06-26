/**
 * Determinisztikus teszt a generikus http_api connectorhoz (DB / élő hálózat nélkül).
 * Futtatás: npm run test:http-api
 *
 * Lefedi: config-validáció, API-kulcs feloldás (env), stub-hívás, endpoint-allowlist,
 * SSRF-védelem (abszolút path elutasítása), és a valódi fetch auth-fejléc injektálását
 * egy befecskendezett fetch-fake-kel.
 */
import assert from 'node:assert/strict'
import {
  HttpApiClient,
  HttpApiError,
  parseHttpApiConfig,
  resolveConnectorApiKey,
  type HttpApiConfig,
} from '../src/domain/connector/http-api-client'

let failures = 0
function pass(name: string) {
  console.log(`  ✓ ${name}`)
}
function fail(name: string, err: unknown) {
  failures += 1
  console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
}
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    pass(name)
  } catch (err) {
    fail(name, err)
  }
}

const baseConfig: HttpApiConfig = parseHttpApiConfig({
  baseUrl: 'https://posnavigator.eu/api/v1',
  auth: { scheme: 'header', header: 'X-Api-Key' },
  endpoints: [
    { method: 'GET', path: '/banks' },
    { method: 'GET', path: '/banks/:bankId/crm' },
    { method: 'POST', path: '/banks/:bankId/contacts' },
  ],
  restrictToEndpoints: true,
})

async function main() {
  console.log('http_api connector')

  await test('parseHttpApiConfig elutasítja a relatív baseUrl-t', () => {
    assert.throws(() => parseHttpApiConfig({ baseUrl: '/api', auth: { scheme: 'bearer' } }))
  })

  await test('parseHttpApiConfig megköveteli a header nevet header-sémánál', () => {
    assert.throws(() =>
      parseHttpApiConfig({ baseUrl: 'https://x.io', auth: { scheme: 'header' } }),
    )
  })

  await test('parseHttpApiConfig levágja a baseUrl záró perjelét', () => {
    const c = parseHttpApiConfig({ baseUrl: 'https://x.io/api/', auth: { scheme: 'bearer' } })
    assert.equal(c.baseUrl, 'https://x.io/api')
  })

  await test('resolveConnectorApiKey env: aliasból olvas', async () => {
    process.env.TEST_CRM_KEY = 'pn_secret_123'
    const key = await resolveConnectorApiKey('env:TEST_CRM_KEY')
    assert.equal(key, 'pn_secret_123')
    delete process.env.TEST_CRM_KEY
  })

  await test('resolveConnectorApiKey hibát dob ismeretlen env-re', async () => {
    await assert.rejects(resolveConnectorApiKey('env:NEM_LETEZIK_XYZ'))
  })

  await test('stub mód strukturált választ ad valódi hálózat nélkül', async () => {
    const client = new HttpApiClient(baseConfig, 'stub-api-key')
    const res = await client.request({ method: 'GET', path: '/banks' })
    assert.equal(res.ok, true)
    assert.equal(res.status, 200)
    assert.deepEqual((res.body as { stub: boolean }).stub, true)
  })

  await test('allowlist: ismeretlen endpoint elutasítva', async () => {
    const client = new HttpApiClient(baseConfig, 'stub-api-key')
    await assert.rejects(
      client.request({ method: 'DELETE', path: '/banks/507f1f77bcf86cd799439011/contacts/abc' }),
      (e: unknown) => e instanceof HttpApiError && e.code === 'endpoint_not_allowed',
    )
  })

  await test('allowlist: :param placeholder illeszkedik', async () => {
    const client = new HttpApiClient(baseConfig, 'stub-api-key')
    const res = await client.request({ method: 'GET', path: '/banks/507f1f77bcf86cd799439011/crm' })
    assert.equal(res.ok, true)
  })

  await test('SSRF-védelem: abszolút URL a path-ban elutasítva', async () => {
    const open = parseHttpApiConfig({ baseUrl: 'https://x.io', auth: { scheme: 'bearer' } })
    const client = new HttpApiClient(open, 'stub-api-key')
    await assert.rejects(
      client.request({ method: 'GET', path: 'https://evil.example/steal' }),
      (e: unknown) => e instanceof HttpApiError && e.code === 'invalid_path',
    )
  })

  await test('valódi fetch: X-Api-Key fejléc injektálva, URL helyes', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} })
      return new Response(JSON.stringify({ success: true, data: { banks: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const client = new HttpApiClient(baseConfig, 'pn_live_key')
      const res = await client.request({ method: 'GET', path: '/banks', query: { limit: 5 } })
      assert.equal(res.status, 200)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://posnavigator.eu/api/v1/banks?limit=5')
      const headers = calls[0].init.headers as Record<string, string>
      assert.equal(headers['X-Api-Key'], 'pn_live_key')
      assert.ok(!('authorization' in headers))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('valódi fetch: 4xx nem dob, strukturált választ ad', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const client = new HttpApiClient(baseConfig, 'pn_live_key')
      const res = await client.request({ method: 'GET', path: '/banks' })
      assert.equal(res.ok, false)
      assert.equal(res.status, 404)
      assert.equal((res.body as { error: { code: string } }).error.code, 'NOT_FOUND')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden http_api teszt zöld.')
}

void main()

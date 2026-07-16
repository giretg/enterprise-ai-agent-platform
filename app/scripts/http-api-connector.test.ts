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

  await test('allowlist: {param} placeholder is illeszkedik (WP-3, sablon-alak)', async () => {
    // A sablonból materializált configok `{id}` alakot használnak — a korlát ezekre
    // is működik, nem csak a kézi form `:param` alakjára.
    const config = parseHttpApiConfig({
      baseUrl: 'https://crm.example/api/v1',
      auth: { scheme: 'bearer' },
      endpoints: [
        { method: 'GET', path: '/accounts' },
        { method: 'GET', path: '/accounts/{id}' },
      ],
      restrictToEndpoints: true,
    })
    const client = new HttpApiClient(config, 'stub-api-key')
    const ok = await client.request({ method: 'GET', path: '/accounts/acc-42' })
    assert.equal(ok.ok, true)
    await assert.rejects(
      client.request({ method: 'GET', path: '/customers' }),
      (e: unknown) => e instanceof HttpApiError && e.code === 'endpoint_not_allowed',
    )
  })

  await test('GitHub repository scope: a kiválasztott owner/repo hívható', async () => {
    const config = parseHttpApiConfig({
      baseUrl: 'https://api.github.com',
      auth: { scheme: 'bearer' },
      githubRepositoryAccess: {
        mode: 'selected',
        repositories: ['giretg/ostorosbor-crm'],
      },
    })
    const client = new HttpApiClient(config, 'stub-api-key')
    const res = await client.request({
      method: 'GET',
      path: '/repos/GIRETG/Ostorosbor-CRM/contents/src',
    })
    assert.equal(res.ok, true)
  })

  await test('GitHub repository scope: másik repository hívása elutasítva', async () => {
    const config = parseHttpApiConfig({
      baseUrl: 'https://api.github.com',
      auth: { scheme: 'bearer' },
      githubRepositoryAccess: {
        mode: 'selected',
        repositories: ['giretg/ostorosbor-crm'],
      },
    })
    const client = new HttpApiClient(config, 'stub-api-key')
    await assert.rejects(
      client.request({
        method: 'GET',
        path: '/repos/giretg/enterprise-ai-agent-platform/contents',
      }),
      (e: unknown) => e instanceof HttpApiError && e.code === 'github_repository_not_allowed',
    )
  })

  await test('GitHub repository scope: dot-segmenttel sem kerülhető meg az allowlist', async () => {
    const config = parseHttpApiConfig({
      baseUrl: 'https://api.github.com',
      auth: { scheme: 'bearer' },
      githubRepositoryAccess: {
        mode: 'selected',
        repositories: ['giretg/ostorosbor-crm'],
      },
    })
    const client = new HttpApiClient(config, 'stub-api-key')
    await assert.rejects(
      client.request({
        method: 'GET',
        path: '/repos/giretg/ostorosbor-crm/../../enterprise-ai-agent-platform/contents',
      }),
      (e: unknown) => e instanceof HttpApiError && e.code === 'github_repository_not_allowed',
    )
  })

  await test('GitHub repository scope: selected módban a repository-listázás elutasítva', async () => {
    const config = parseHttpApiConfig({
      baseUrl: 'https://api.github.com',
      auth: { scheme: 'bearer' },
      githubRepositoryAccess: {
        mode: 'selected',
        repositories: ['giretg/ostorosbor-crm'],
      },
    })
    const client = new HttpApiClient(config, 'stub-api-key')
    await assert.rejects(
      client.request({ method: 'GET', path: '/user/repos' }),
      (e: unknown) => e instanceof HttpApiError && e.code === 'github_repository_scope_required',
    )
  })

  await test('GitHub repository scope: any módban bármely repository hívható', async () => {
    const config = parseHttpApiConfig({
      baseUrl: 'https://api.github.com',
      auth: { scheme: 'bearer' },
      githubRepositoryAccess: { mode: 'any' },
    })
    const client = new HttpApiClient(config, 'stub-api-key')
    const res = await client.request({
      method: 'GET',
      path: '/repos/giretg/enterprise-ai-agent-platform/contents',
    })
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

  await test('valódi fetch: sablonozott fejléceket és idempotencia kulcsot injektál', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const config = parseHttpApiConfig({
        baseUrl: 'https://crm.example/api/connector/v1',
        auth: { scheme: 'bearer' },
        requestHeaders: {
          'X-Agent-Id': '{{agent.id}}',
          'X-Acting-User': '{{actingUser.email}}',
          'X-Connector-Call-Id': '{{call.id}}',
        },
        endpoints: [{ method: 'POST', path: '/tasks', idempotent: true }],
        restrictToEndpoints: true,
      })
      const client = new HttpApiClient(config, 'crm_key')
      await client.request({
        method: 'POST',
        path: '/tasks',
        body: { title: 'Teszt' },
        context: {
          agent: { id: 'ostoros-crm-testpilot', version: 3 },
          connector: { id: 'connector-1', name: 'Ostoros CRM' },
          actingUser: {
            id: 'user-1',
            email: 'ertekesito@ostorosbor.hu',
            tenantId: 'tenant-1',
          },
          tenant: { id: 'tenant-1' },
          call: { id: 'call-001', idempotencyKey: 'idem-001' },
          now: { iso: '2026-06-28T00:00:00.000Z' },
        },
      })
      const headers = calls[0].init.headers as Record<string, string>
      assert.equal(headers.authorization, 'Bearer crm_key')
      assert.equal(headers['X-Agent-Id'], 'ostoros-crm-testpilot')
      assert.equal(headers['X-Acting-User'], 'ertekesito@ostorosbor.hu')
      assert.equal(headers['X-Connector-Call-Id'], 'call-001')
      assert.equal(headers['Idempotency-Key'], 'idem-001')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('valódi fetch: endpoint auth profil külön secretet használ', async () => {
    process.env.CRM_DELEGATED_TEST_KEY = 'delegated-secret'
    const calls: RequestInit[] = []
    const fakeFetch: typeof fetch = async (_input, init) => {
      calls.push(init ?? {})
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const config = parseHttpApiConfig({
        baseUrl: 'https://crm.example/api/connector/v1',
        auth: { scheme: 'bearer' },
        authProfiles: {
          delegated: { secretAlias: 'env:CRM_DELEGATED_TEST_KEY' },
        },
        endpoints: [{ method: 'POST', path: '/interactions', profile: 'delegated' }],
        restrictToEndpoints: true,
      })
      const client = new HttpApiClient(config, {
        defaultApiKey: 'service-secret',
        resolveProfileApiKey: (_profile, secretAlias) => resolveConnectorApiKey(secretAlias),
      })
      await client.request({
        method: 'POST',
        path: '/interactions',
        body: { summary: 'Teszt' },
        context: {
          agent: { id: 'agent-1' },
          connector: { id: 'connector-1', name: 'CRM' },
          actingUser: null,
          tenant: null,
          call: { id: 'call-002', idempotencyKey: 'idem-002' },
          now: { iso: '2026-06-28T00:00:00.000Z' },
        },
      })
      const headers = calls[0].headers as Record<string, string>
      assert.equal(headers.authorization, 'Bearer delegated-secret')
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.CRM_DELEGATED_TEST_KEY
    }
  })

  await test('parseHttpApiConfig elfogadja az oauth2 sémát (tokenUrl+clientId)', () => {
    const c = parseHttpApiConfig({
      baseUrl: 'https://x.io',
      auth: { type: 'oauth2', tokenUrl: 'https://oauth2.example/token', clientId: 'abc' },
    })
    assert.deepEqual(c.auth, { scheme: 'oauth2', tokenUrl: 'https://oauth2.example/token', clientId: 'abc' })
  })

  await test('parseHttpApiConfig elutasítja az oauth2-t tokenUrl nélkül', () => {
    assert.throws(() =>
      parseHttpApiConfig({ baseUrl: 'https://x.io', auth: { type: 'oauth2', clientId: 'abc' } }),
    )
  })

  await test('parseHttpApiConfig elfogadja a basic sémát', () => {
    const c = parseHttpApiConfig({ baseUrl: 'https://x.io', auth: { type: 'basic' } })
    assert.deepEqual(c.auth, { scheme: 'basic' })
  })

  await test('valódi fetch: basic séma Authorization: Basic fejlécet küld', async () => {
    const calls: RequestInit[] = []
    const fakeFetch: typeof fetch = async (_input, init) => {
      calls.push(init ?? {})
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const config = parseHttpApiConfig({ baseUrl: 'https://x.io', auth: { scheme: 'basic' } })
      const client = new HttpApiClient(config, 'dXNlcjpwYXNz')
      await client.request({ method: 'GET', path: '/ping' })
      const headers = calls[0].headers as Record<string, string>
      assert.equal(headers.authorization, 'Basic dXNlcjpwYXNz')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('valódi fetch: oauth2 séma refresh_token grant-tal access tokent szerez, cache-el', async () => {
    let tokenCalls = 0
    const apiCalls: RequestInit[] = []
    const fakeFetch: typeof fetch = async (input, init) => {
      if (String(input) === 'https://oauth2.example/token') {
        tokenCalls += 1
        return new Response(JSON.stringify({ access_token: `tok-${tokenCalls}`, expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      apiCalls.push(init ?? {})
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const config = parseHttpApiConfig({
        baseUrl: 'https://x.io',
        auth: { scheme: 'oauth2', tokenUrl: 'https://oauth2.example/token', clientId: 'client-abc' },
      })
      const credentials = JSON.stringify({ clientSecret: 'shh', refreshToken: 'rt-1' })
      const client = new HttpApiClient(config, credentials)
      await client.request({ method: 'GET', path: '/a' })
      await client.request({ method: 'GET', path: '/b' })
      assert.equal(tokenCalls, 1, 'a második hívás a cache-elt tokent használja, nincs újra-refresh')
      assert.equal((apiCalls[0].headers as Record<string, string>).authorization, 'Bearer tok-1')
      assert.equal((apiCalls[1].headers as Record<string, string>).authorization, 'Bearer tok-1')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('oauth2: hibás JSON secret esetén tiszta hiba, nem nyers stringet küld tokenként', async () => {
    const config = parseHttpApiConfig({
      baseUrl: 'https://x.io',
      auth: { scheme: 'oauth2', tokenUrl: 'https://oauth2.example/token', clientId: 'client-abc' },
    })
    const client = new HttpApiClient(config, 'not-json-at-all')
    await assert.rejects(
      client.request({ method: 'GET', path: '/a' }),
      (e: unknown) => e instanceof HttpApiError && e.code === 'oauth2_credentials_invalid',
    )
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden http_api teszt zöld.')
}

void main()

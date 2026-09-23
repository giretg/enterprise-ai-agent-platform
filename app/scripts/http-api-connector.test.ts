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
  findHttpApiEndpoint,
  findOverlappingHttpApiEndpoints,
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

  await test('parseHttpApiConfig megőrzi az endpoint lapozási szerződését', () => {
    const c = parseHttpApiConfig({
      baseUrl: 'https://x.io/api',
      auth: { scheme: 'bearer' },
      endpoints: [{
        method: 'GET',
        path: '/accounts',
        pagination: {
          kind: 'cursor', cursorParam: 'cursor', limitParam: 'limit',
          itemsPath: 'data', nextCursorPath: 'meta.nextCursor',
        },
      }],
    })
    assert.deepEqual(c.endpoints?.[0]?.pagination, {
      kind: 'cursor', cursorParam: 'cursor', limitParam: 'limit',
      itemsPath: 'data', nextCursorPath: 'meta.nextCursor',
    })
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
      (e: unknown) =>
        e instanceof HttpApiError
        && e.code === 'endpoint_not_allowed'
        && Array.isArray(e.allowedEndpoints)
        && e.allowedEndpoints.length > 0
        && !JSON.stringify(e.allowedEndpoints).includes('stub-api-key'),
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

  await test('allowlist: szegmensen belüli {param} (előtag/utótag) illeszkedik, a legspecifikusabb nyer', async () => {
    const config = parseHttpApiConfig({
      baseUrl: 'https://graph.example/v1',
      auth: { scheme: 'bearer' },
      endpoints: [
        { method: 'GET', path: '/{objectId}', description: 'tág' },
        { method: 'GET', path: '/act_{accountId}', description: 'fiók' },
        { method: 'GET', path: '/act_{accountId}/campaigns' },
        { method: 'POST', path: '/act_{accountId}/campaigns' },
        { method: 'GET', path: '/files/{id}.json' },
      ],
      restrictToEndpoints: true,
    })
    assert.equal(findHttpApiEndpoint(config, 'GET', '/act_123')?.description, 'fiók')
    assert.equal(findHttpApiEndpoint(config, 'GET', '/999')?.description, 'tág')
    assert.equal(findHttpApiEndpoint(config, 'GET', '/act_123/campaigns?limit=5')?.path, '/act_{accountId}/campaigns')
    assert.equal(findHttpApiEndpoint(config, 'POST', '/act_123/campaigns')?.method, 'POST')
    assert.ok(findHttpApiEndpoint(config, 'GET', '/files/7.json'))
    assert.equal(findHttpApiEndpoint(config, 'GET', '/files/7.xml'), undefined)
    assert.equal(findHttpApiEndpoint(config, 'GET', '/act_/campaigns'), undefined)
    const client = new HttpApiClient(config, 'stub-api-key')
    assert.equal((await client.request({ method: 'GET', path: '/act_123/campaigns' })).ok, true)
  })

  await test('endpoint_not_allowed: reason megmondja, ha csak a metódus rossz', async () => {
    const config = parseHttpApiConfig({
      baseUrl: 'https://api.example/v1',
      auth: { scheme: 'bearer' },
      endpoints: [{ method: 'GET', path: '/items/{id}' }],
      restrictToEndpoints: true,
    })
    const client = new HttpApiClient(config, 'stub-api-key')
    await assert.rejects(
      client.request({ method: 'DELETE', path: '/items/1' }),
      (e: unknown) => e instanceof HttpApiError && /method DELETE .*allowed: GET/.test(e.reason ?? ''),
    )
    await assert.rejects(
      client.request({ method: 'GET', path: '/other' }),
      (e: unknown) => e instanceof HttpApiError && /no allowed endpoint template/.test(e.reason ?? ''),
    )
  })

  await test('átfedő sablonok felismerése (azonos metódus, közös konkrét path)', () => {
    const pairs = findOverlappingHttpApiEndpoints([
      { method: 'GET', path: '/{campaignId}' },
      { method: 'GET', path: '/act_{adAccountId}' },
      { method: 'GET', path: '/me' },
      { method: 'POST', path: '/act_{adAccountId}' },
      { method: 'GET', path: '/act_{adAccountId}/campaigns' },
      { method: 'GET', path: '/items/{id}' },
      { method: 'GET', path: '/users/{id}' },
    ])
    assert.deepEqual(pairs, [
      ['GET /{campaignId}', 'GET /act_{adAccountId}'],
      ['GET /{campaignId}', 'GET /me'],
    ])
  })

  await test('allowlist: next_link endpoint szerver által adott relatív continuation pathja hívható', async () => {
    const config = parseHttpApiConfig({
      baseUrl: 'https://api.example/v1',
      auth: { scheme: 'bearer' },
      endpoints: [{
        method: 'GET', path: '/items',
        pagination: {
          kind: 'next_link', linkHeaderRel: 'next', itemsPath: 'items',
          continuationPathTemplate: '/items/page/{page}',
        },
      }],
      restrictToEndpoints: true,
    })
    const client = new HttpApiClient(config, 'stub-api-key')
    const result = await client.request({
      method: 'GET', path: '/items/page/2', continuationOf: '/items',
    })
    assert.equal(result.ok, true)
    await assert.rejects(
      client.request({ method: 'GET', path: '/items/page/2' }),
      (e: unknown) => e instanceof HttpApiError && e.code === 'endpoint_not_allowed',
    )
    await assert.rejects(
      client.request({
        method: 'GET', path: '/admin/secrets', continuationOf: '/items',
      }),
      (e: unknown) => e instanceof HttpApiError && e.code === 'endpoint_not_allowed',
    )
    await assert.rejects(
      new HttpApiClient(baseConfig, 'stub-api-key').request({
        method: 'GET', path: '/banks/page/2', continuationOf: '/banks',
      }),
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

  const crmTraceContext = {
    agent: { id: 'agent-trace', version: 1 },
    connector: { id: 'connector-trace', name: 'CRM' },
    actingUser: { id: 'u1', email: 'u@example.com', tenantId: 't1' },
    tenant: { id: 't1' },
    call: { id: 'call-trace', idempotencyKey: 'idem-trace' },
    now: { iso: '2026-07-30T00:00:00.000Z' },
  }

  await test('parse: requestHeaders-ben lévő kötelező OpenAPI header nem kerül headerParams-ba', () => {
    const config = parseHttpApiConfig({
      baseUrl: 'https://crm.example/api/v1',
      auth: { scheme: 'bearer' },
      requestHeaders: {
        'X-Agent-Id': '{{agent.id}}',
        'X-Acting-User': '{{actingUser.email}}',
        'X-Connector-Call-Id': '{{call.id}}',
      },
      endpoints: [
        {
          method: 'GET',
          path: '/orders',
          parameters: [
            { name: 'X-Agent-Id', in: 'header', required: true },
            { name: 'X-Acting-User', in: 'header', required: true },
            { name: 'X-Connector-Call-Id', in: 'header', required: true },
            { name: 'X-Request-Id', in: 'header', required: false },
          ],
        },
      ],
    })
    const ep = config.endpoints?.[0]
    assert.ok(ep)
    assert.deepEqual(ep.headerParams, [{ name: 'X-Request-Id', required: false }])
  })

  await test('parse: csak az adott metóduson ténylegesen injektált fejléceket szűri', () => {
    const sharedParameters = [
      { name: 'X-Write-Token', in: 'header', required: true },
      { name: 'Idempotency-Key', in: 'header', required: true },
    ]
    const config = parseHttpApiConfig({
      baseUrl: 'https://crm.example/api/v1',
      auth: { scheme: 'bearer' },
      writeHeaders: { 'X-Write-Token': '{{call.id}}' },
      endpoints: [
        { method: 'GET', path: '/orders', parameters: sharedParameters },
        { method: 'POST', path: '/orders', idempotent: true, parameters: sharedParameters },
      ],
    })
    assert.deepEqual(config.endpoints?.[0].headerParams, [
      { name: 'X-Write-Token', required: true },
      { name: 'Idempotency-Key', required: true },
    ])
    assert.equal(config.endpoints?.[1].headerParams, undefined)
  })

  await test('runtime: sablon-fedett required header nélkül is sikerül a hívás', async () => {
    const calls: Array<{ init: RequestInit }> = []
    const fakeFetch: typeof fetch = async (_input, init) => {
      calls.push({ init: init ?? {} })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      // Szándékosan headerParams-ban hagyjuk a platform fejléceket (régi snapshot
      // szimulációja) — a runtime sablon alapján akkor sem követeli a hívótól.
      const config: HttpApiConfig = {
        ...parseHttpApiConfig({
          baseUrl: 'https://crm.example/api/v1',
          auth: { scheme: 'bearer' },
          requestHeaders: {
            'X-Agent-Id': '{{agent.id}}',
            'X-Acting-User': '{{actingUser.email}}',
            'X-Connector-Call-Id': '{{call.id}}',
          },
          endpoints: [{ method: 'GET', path: '/orders' }],
          restrictToEndpoints: true,
        }),
        endpoints: [
          {
            method: 'GET',
            path: '/orders',
            headerParams: [
              { name: 'X-Agent-Id', required: true },
              { name: 'X-Acting-User', required: true },
              { name: 'X-Connector-Call-Id', required: true },
            ],
          },
        ],
      }
      const client = new HttpApiClient(config, 'crm_key')
      const res = await client.request({
        method: 'GET',
        path: '/orders',
        context: crmTraceContext,
      })
      assert.equal(res.ok, true)
      const headers = calls[0].init.headers as Record<string, string>
      assert.equal(headers['X-Agent-Id'], 'agent-trace')
      assert.equal(headers['X-Acting-User'], 'u@example.com')
      assert.equal(headers['X-Connector-Call-Id'], 'call-trace')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('runtime: GitHub Contents base64 body → utf-8 dekódolva', async () => {
    const markdown = '# Riportok\n\nElérhető riportok listája.\n'
    const payload = {
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(markdown, 'utf8').toString('base64'),
      path: 'docs/felhasznaloi-kezikonyv.md',
      name: 'felhasznaloi-kezikonyv.md',
      sha: 'deadbeef',
      download_url: 'https://raw.githubusercontent.com/o/r/main/docs/f.md',
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    try {
      const config = parseHttpApiConfig({
        baseUrl: 'https://api.github.com',
        auth: { scheme: 'bearer' },
        endpoints: [{ method: 'GET', path: '/repos/:owner/:repo/contents/*' }],
        restrictToEndpoints: false,
      })
      const client = new HttpApiClient(config, 'gh_token')
      const res = await client.request({
        method: 'GET',
        path: '/repos/o/r/contents/docs/felhasznaloi-kezikonyv.md',
      })
      assert.equal(res.ok, true)
      const body = res.body as Record<string, unknown>
      assert.equal(body.encoding, 'utf-8')
      assert.equal(body.content, markdown)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('runtime: dekódolt forrásfájl nem kap csonkolás-jelzést a base64 hossza miatt', async () => {
    // A base64 ~33%-kal hosszabb: a nyers válasz átlépi a limitet, a dekódolt
    // fájl viszont bőven alatta marad — a modellnek nem szabad azt hinnie,
    // hogy csonka forráskódot kapott.
    const source = 'export function riport() {\n  return 42\n}\n'.repeat(200)
    const payload = {
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(source, 'utf8').toString('base64'),
      path: 'app/src/riport.ts',
      name: 'riport.ts',
      sha: 'cafebabe',
      download_url: 'https://raw.githubusercontent.com/o/r/main/app/src/riport.ts',
    }
    const rawJson = JSON.stringify(payload)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(rawJson, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    try {
      const config = parseHttpApiConfig({
        baseUrl: 'https://api.github.com',
        auth: { scheme: 'bearer' },
        // A nyers válasz fölötte, a dekódolt tartalom alatta van a limitnek.
        maxResponseChars: Math.floor((rawJson.length + source.length) / 2),
        endpoints: [{ method: 'GET', path: '/repos/:owner/:repo/contents/*' }],
      })
      assert.ok(rawJson.length > (config.maxResponseChars ?? 0), 'a nyers válasz limit fölött van')
      const client = new HttpApiClient(config, 'gh_token')
      const res = await client.request({
        method: 'GET',
        path: '/repos/o/r/contents/app/src/riport.ts',
      })
      assert.equal(res.ok, true)
      assert.equal(res.truncated, undefined)
      assert.equal(res.hint, undefined)
      assert.equal((res.body as Record<string, unknown>).content, source)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('runtime: actingUser.email nélkül a CRM-hívás fetch ELŐTT elhasal', async () => {
    let fetched = false
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      fetched = true
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const config = parseHttpApiConfig({
        baseUrl: 'https://crm.example/api/connector/v1',
        auth: { scheme: 'bearer' },
        requestHeaders: {
          'X-Agent-Id': '{{agent.id}}',
          'X-Acting-User': '{{actingUser.email}}',
          'X-Connector-Call-Id': '{{call.id}}',
        },
        endpoints: [{ method: 'GET', path: '/orders' }],
        restrictToEndpoints: true,
      })
      const client = new HttpApiClient(config, 'crm_key')
      await assert.rejects(
        client.request({
          method: 'GET',
          path: '/orders',
          context: {
            ...crmTraceContext,
            actingUser: null,
          },
        }),
        (e: unknown) =>
          e instanceof HttpApiError &&
          e.code === 'template_variable_missing' &&
          e.message.includes('actingUser.email'),
      )
      assert.equal(fetched, false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('runtime: defaultActingUserEmail fallback acting user nélkül is megy', async () => {
    const calls: Array<{ init: RequestInit }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      calls.push({ init: init ?? {} })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const config = parseHttpApiConfig({
        baseUrl: 'https://crm.example/api/connector/v1',
        auth: { scheme: 'bearer' },
        defaultActingUserEmail: 'fallback@ostorosbor.hu',
        requestHeaders: {
          'X-Agent-Id': '{{agent.id}}',
          'X-Acting-User': '{{actingUser.email}}',
          'X-Connector-Call-Id': '{{call.id}}',
        },
        endpoints: [{ method: 'GET', path: '/orders' }],
        restrictToEndpoints: true,
      })
      const client = new HttpApiClient(config, 'crm_key')
      const res = await client.request({
        method: 'GET',
        path: '/orders',
        context: {
          ...crmTraceContext,
          actingUser: null,
          defaultActingUserEmail: config.defaultActingUserEmail,
        },
      })
      assert.equal(res.ok, true)
      const headers = calls[0].init.headers as Record<string, string>
      assert.equal(headers['X-Acting-User'], 'fallback@ostorosbor.hu')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('runtime: endpoint saját OpenAPI-ja szerint opcionális X-Acting-User → kihagyva, nem hasal el', async () => {
    const calls: Array<{ init: RequestInit }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      calls.push({ init: init ?? {} })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      // Ez az Ostorosbor CRM valódi `listOrders` endpointjának alakja: az OpenAPI
      // maga jelöli az X-Acting-User-t required:false-nak — nincs actingUser és
      // defaultActingUserEmail sem, ez ettől még nem hibázhat el.
      const config = parseHttpApiConfig({
        baseUrl: 'https://crm.example/api/connector/v1',
        auth: { scheme: 'bearer' },
        requestHeaders: {
          'X-Agent-Id': '{{agent.id}}',
          'X-Acting-User': '{{actingUser.email}}',
          'X-Connector-Call-Id': '{{call.id}}',
        },
        endpoints: [
          {
            method: 'GET',
            path: '/orders',
            parameters: [
              { in: 'header', name: 'X-Acting-User', required: false },
              { in: 'header', name: 'X-Agent-Id', required: true },
              { in: 'header', name: 'X-Connector-Call-Id', required: true },
            ],
          },
        ],
        restrictToEndpoints: true,
      })
      const client = new HttpApiClient(config, 'crm_key')
      const res = await client.request({
        method: 'GET',
        path: '/orders',
        context: { ...crmTraceContext, actingUser: null },
      })
      assert.equal(res.ok, true)
      const headers = calls[0].init.headers as Record<string, string>
      assert.equal(headers['X-Acting-User'], undefined)
      assert.ok(headers['X-Agent-Id'] !== undefined)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('runtime: hívó által beadott platform-injektált header → platform_injected_header', async () => {
    const config = parseHttpApiConfig({
      baseUrl: 'https://crm.example/api/v1',
      auth: { scheme: 'bearer' },
      requestHeaders: { 'X-Agent-Id': '{{agent.id}}' },
      endpoints: [{ method: 'GET', path: '/orders' }],
      restrictToEndpoints: true,
    })
    const client = new HttpApiClient(config, 'crm_key')
    await assert.rejects(
      client.request({
        method: 'GET',
        path: '/orders',
        headers: { 'X-Agent-Id': 'spoofed-agent' },
        context: crmTraceContext,
      }),
      (e: unknown) => e instanceof HttpApiError && e.code === 'platform_injected_header',
    )
  })

  await test('SSRF: idegen hostra mutató redirectet NEM követ (metadata/belső host blokk)', async () => {
    const calls: string[] = []
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(String(input))
      // Az allowlistolt (konfigurált) host egy nyílt-redirekttel a felhő-metadata hostra
      // próbál átirányítani — ezt a kliensnek blokkolnia kell, nem szabad követnie.
      return new Response(null, {
        status: 302,
        headers: { location: 'https://169.254.169.254/latest/meta-data/iam/security-credentials/' },
      })
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const client = new HttpApiClient(baseConfig, 'live-key')
      await assert.rejects(
        client.request({ method: 'GET', path: '/banks', context: crmTraceContext }),
        (e: unknown) => e instanceof HttpApiError && e.code === 'egress_blocked',
      )
      // Csak az eredeti host lett meghívva; a metadata hostra SOSEM ment ki kérés.
      assert.equal(calls.length, 1)
      assert.ok(calls[0].startsWith('https://posnavigator.eu/'))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('redirect: azonos-host átirányítást KÖVET, majd a 200-at adja vissza', async () => {
    const calls: string[] = []
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input)
      calls.push(url)
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://posnavigator.eu/api/v1/banks/moved' },
        })
      }
      return new Response(JSON.stringify({ ok: true, moved: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const client = new HttpApiClient(baseConfig, 'live-key')
      const res = await client.request({ method: 'GET', path: '/banks', context: crmTraceContext })
      assert.equal(res.ok, true)
      assert.equal((res.body as Record<string, unknown>).moved, true)
      assert.equal(calls.length, 2)
      assert.equal(calls[1], 'https://posnavigator.eu/api/v1/banks/moved')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('SSRF: azonos hostnév MÁS PORTRA (belső admin) mutató redirectet NEM követ', async () => {
    const calls: string[] = []
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(String(input))
      // Azonos hostnév, de belső admin/docker port — az origin (host:port) más, ezért blokk.
      return new Response(null, {
        status: 302,
        headers: { location: 'https://posnavigator.eu:2375/v1.40/containers/json' },
      })
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const client = new HttpApiClient(baseConfig, 'live-key')
      await assert.rejects(
        client.request({ method: 'GET', path: '/banks', context: crmTraceContext }),
        (e: unknown) => e instanceof HttpApiError && e.code === 'egress_blocked',
      )
      assert.equal(calls.length, 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('redirect: azonos-host átirányítás-hurok a hop-limitnél blokkol', async () => {
    let n = 0
    const fakeFetch: typeof fetch = async () => {
      n += 1
      return new Response(null, {
        status: 302,
        headers: { location: `https://posnavigator.eu/api/v1/loop/${n}` },
      })
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const client = new HttpApiClient(baseConfig, 'live-key')
      await assert.rejects(
        client.request({ method: 'GET', path: '/banks', context: crmTraceContext }),
        (e: unknown) => e instanceof HttpApiError && e.code === 'egress_blocked',
      )
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

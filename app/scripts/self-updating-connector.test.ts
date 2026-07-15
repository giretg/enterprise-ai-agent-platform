/**
 * Önfrissítő connector — capability-diff + szinkron-motor determinisztikus tesztek.
 * Futtatás: npm run test:self-updating-connector
 *
 * Fedi: additív/breaking/szűkítő/auth diff, első-rögzítés, auto-jóváhagyás (D5/T4),
 * fail-closed szinkron (SSRF, nem-OpenAPI, too_large), sikeres parse + hash.
 */
import assert from 'node:assert/strict'
import { extractConnectorConfigFromOpenApiSpec } from '../src/domain/provisioning/openapi-config-extractor'
import type { ConnectorConfig } from '../src/domain/provisioning/connector-config'
import {
  computeCapabilityDiff,
  isAutoApprovable,
  type UsedByResolver,
} from '../src/domain/connector-self-update/spec-diff'
import { SpecSyncService, specContentHash } from '../src/domain/connector-self-update/spec-sync'
import { pinnedRuntimeConfig } from '../src/domain/connector-self-update/pinned-runtime-config'
import { HttpApiClient, HttpApiError, parseHttpApiConfig } from '../src/domain/connector/http-api-client'

// ── OpenAPI fixture-ök ──────────────────────────────────────────────────────
function baseSpec(paths: Record<string, unknown>, opts?: { title?: string; security?: unknown }) {
  return {
    openapi: '3.0.3',
    info: { title: opts?.title ?? 'Partner CRM', version: '1.0.0' },
    servers: [{ url: 'https://api.partner-crm.example/v1' }],
    components: { securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } } },
    security: opts?.security ?? [{ ApiKeyAuth: [] }],
    paths,
  }
}

function extract(spec: unknown): ConnectorConfig {
  const r = extractConnectorConfigFromOpenApiSpec(spec as Record<string, unknown>)
  if (!r.ok) throw new Error(`fixture extract failed: ${r.reason}`)
  return r.config
}

const V1 = extract(
  baseSpec({
    '/orders': { post: { operationId: 'createOrder' } },
    '/orders/{id}': { get: { operationId: 'getOrder' }, delete: { operationId: 'deleteOrder' } },
    '/customers': { get: { operationId: 'listCustomers' } },
  }),
)

// V2: + /invoices/{id}/pdf (additív), - DELETE /orders/{id} (eltűnt), POST /orders idempotenssé vált.
const V2 = extract(
  baseSpec({
    '/orders': {
      post: {
        operationId: 'createOrder',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
      },
    },
    '/orders/{id}': { get: { operationId: 'getOrder' } },
    '/customers': { get: { operationId: 'listCustomers' } },
    '/invoices/{id}/pdf': { get: { operationId: 'getInvoicePdf' } },
  }),
)

const noUsage: UsedByResolver = () => []
const deleteOrderUsed: UsedByResolver = (op) =>
  op === 'DELETE /orders/{id}' ? [{ type: 'playbook', name: 'Rendelés-rögzítés', id: 'pb_123' }] : []

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    console.error(`✗ ${name}`)
    throw e
  }
}

async function run() {
  // ── WP-3: diff ────────────────────────────────────────────────────────────
  await test('első rögzítés → minden végpont added, a célhost és auth explicit magas kockázatú', () => {
    const diff = computeCapabilityDiff(null, V1, noUsage)
    assert.equal(diff.breaking.length, 0)
    assert.equal(diff.narrowed.length, 0)
    assert.equal(diff.added.length, V1.proposedTools.length)
    assert.ok(diff.auth.some((item) => item.change?.startsWith('initial_base_url:')))
    assert.ok(diff.auth.some((item) => item.change?.startsWith('initial_auth_mode:')))
    assert.equal(diff.highestRisk, 'high')
    assert.ok(diff.hasChanges)
  })

  await test('additív: új végpont GET /invoices/{id}/pdf → added, alacsony kockázat', () => {
    const diff = computeCapabilityDiff(V1, V2, noUsage)
    const added = diff.added.map((d) => d.op)
    assert.ok(added.includes('GET /invoices/{id}/pdf'), `added: ${added.join(', ')}`)
    assert.ok(diff.added.every((d) => d.risk === 'low'))
  })

  await test('szűkítő (nem használt): DELETE /orders/{id} eltűnt → narrowed, közepes', () => {
    const diff = computeCapabilityDiff(V1, V2, noUsage)
    const narrowed = diff.narrowed.map((d) => d.op)
    assert.ok(narrowed.includes('DELETE /orders/{id}'))
    assert.equal(diff.breaking.filter((d) => d.op === 'DELETE /orders/{id}').length, 0)
  })

  await test('breaking (HASZNÁLT): ugyanaz eltűnt végpont folyamattal → breaking + usedBy', () => {
    const diff = computeCapabilityDiff(V1, V2, deleteOrderUsed)
    const b = diff.breaking.find((d) => d.op === 'DELETE /orders/{id}')
    assert.ok(b, 'breaking hiányzik')
    assert.equal(b!.risk, 'high')
    assert.deepEqual(b!.usedBy, [{ type: 'playbook', name: 'Rendelés-rögzítés', id: 'pb_123' }])
    // A "ki használja" kontextus nélkül ugyanez csak narrowed lenne — a resolver dönt.
    assert.equal(diff.narrowed.some((d) => d.op === 'DELETE /orders/{id}'), false)
  })

  await test('auth: POST /orders kötelező Idempotency-Key lett → auth kategória, magas', () => {
    const diff = computeCapabilityDiff(V1, V2, noUsage)
    const a = diff.auth.find((d) => d.op === 'POST /orders')
    assert.ok(a, 'auth tétel hiányzik')
    assert.equal(a!.risk, 'high')
    assert.match(a!.change ?? '', /Idempotency-Key/)
    assert.equal(diff.highestRisk, 'high')
  })

  await test('auth-mód váltás (bearer → apiKey) → AUTH * teljes scope, magas', () => {
    const bearer = extract(
      baseSpec(
        { '/ping': { get: { operationId: 'ping' } } },
        { title: 'X' },
      ),
    )
    // Kézzel auth-módot váltunk a második oldalon.
    const oauthLike: ConnectorConfig = {
      ...bearer,
      authMode: 'user_delegated',
      auth: { type: 'oauth2', authUrl: 'https://api.partner-crm.example/oauth', tokenUrl: 'https://api.partner-crm.example/token' },
    }
    const diff = computeCapabilityDiff(bearer, oauthLike, noUsage)
    const a = diff.auth.find((d) => d.op === 'AUTH *')
    assert.ok(a, 'auth-mód váltás nem jelent meg')
    assert.equal(a!.scope, '*')
  })

  await test('azonos API-key auth típus mellett a fejlécnév változása is auth diff', () => {
    const renamed: ConnectorConfig = { ...V1, auth: { ...V1.auth, type: 'api_key_header', headerName: 'X-New-Key' } }
    const diff = computeCapabilityDiff(V1, renamed)
    assert.ok(diff.auth.some((item) => item.change?.startsWith('auth_config_changed:')))
    assert.equal(isAutoApprovable(diff, { enabled: true }), false)
  })

  await test('kötelező paraméter hozzáadása → breaking + használati hatáslista', () => {
    const before = extract(baseSpec({ '/orders': { post: { operationId: 'createOrder' } } }))
    const after = extract(baseSpec({
      '/orders': { post: { operationId: 'createOrder', parameters: [
        { name: 'currency', in: 'query', required: true, schema: { type: 'string' } },
      ] } },
    }))
    const diff = computeCapabilityDiff(before, after, () => [{ type: 'agent', name: 'Rendeléskezelő', id: 'agent-1' }])
    const change = diff.breaking.find((item) => item.change?.includes('required_param_added: query currency'))
    assert.ok(change)
    assert.equal(change!.usedBy?.[0]?.name, 'Rendeléskezelő')
  })

  await test('opcionális paraméter hozzáadása → additív; paramétertípus-váltás → breaking', () => {
    const before = extract(baseSpec({ '/customers': { get: { operationId: 'listCustomers', parameters: [
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
    ] } } }))
    const optional = extract(baseSpec({ '/customers': { get: { operationId: 'listCustomers', parameters: [
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'tag', in: 'query', required: false, schema: { type: 'string' } },
    ] } } }))
    assert.ok(computeCapabilityDiff(before, optional).added.some((item) => item.change?.includes('optional_param_added: query tag')))

    const changedType = extract(baseSpec({ '/customers': { get: { operationId: 'listCustomers', parameters: [
      { name: 'limit', in: 'query', required: false, schema: { type: 'string' } },
    ] } } }))
    assert.ok(computeCapabilityDiff(before, changedType).breaking.some((item) => item.change?.includes('param_type_changed: query limit')))
  })

  await test('request body $ref mögötti kötelező mező változása is breakingként látszik', () => {
    const specWithBody = (required: string[]) => {
      const spec = baseSpec({
        '/orders': { post: { operationId: 'createOrder', requestBody: { required: true, content: {
          'application/json': { schema: { $ref: '#/components/schemas/Order' } },
        } } } },
      })
      ;(spec.components as Record<string, unknown>).schemas = {
        Order: { type: 'object', required, properties: { customerId: { type: 'string' }, currency: { type: 'string' } } },
      }
      return spec
    }
    const before = extract(specWithBody(['customerId']))
    const after = extract(specWithBody(['customerId', 'currency']))
    assert.ok(computeCapabilityDiff(before, after).breaking.some((item) => item.change?.includes('param_type_changed: body application/json')))
  })

  await test('nincs változás: azonos set → hasChanges=false', () => {
    const diff = computeCapabilityDiff(V1, V1, noUsage)
    assert.equal(diff.hasChanges, false)
    assert.equal(diff.highestRisk, 'none')
  })

  await test('API cél-host változása magas kockázatú auth-változás, sosem auto-approve', () => {
    const moved: ConnectorConfig = { ...V1, baseUrl: 'https://other.example/v1', egressHosts: ['other.example'] }
    const diff = computeCapabilityDiff(V1, moved)
    assert.ok(diff.auth.some((item) => item.change?.startsWith('base_url_changed:')))
    assert.ok(diff.auth.some((item) => item.change?.startsWith('egress_hosts_changed:')))
    assert.equal(isAutoApprovable(diff, { enabled: true }), false)
  })

  // ── D5/T4: auto-jóváhagyás ─────────────────────────────────────────────────
  await test('auto-jóváhagyás: policy KI → sosem auto', () => {
    const additive = computeCapabilityDiff(V1, extract(baseSpec({
      '/orders': { post: { operationId: 'createOrder' } },
      '/orders/{id}': { get: { operationId: 'getOrder' }, delete: { operationId: 'deleteOrder' } },
      '/customers': { get: { operationId: 'listCustomers' } },
      '/reports': { get: { operationId: 'listReports' } }, // tisztán additív, read-only
    })), noUsage)
    assert.equal(isAutoApprovable(additive, { enabled: false }), false)
    assert.equal(isAutoApprovable(additive, null), false)
    assert.equal(isAutoApprovable(additive, { enabled: true }), true)
  })

  await test('auto-jóváhagyás: additív WRITE alapból NEM megy (allowAddedWrite nélkül)', () => {
    const addedWrite = computeCapabilityDiff(V1, extract(baseSpec({
      '/orders': { post: { operationId: 'createOrder' } },
      '/orders/{id}': { get: { operationId: 'getOrder' }, delete: { operationId: 'deleteOrder' } },
      '/customers': { get: { operationId: 'listCustomers' }, post: { operationId: 'createCustomer' } },
    })), noUsage)
    assert.equal(isAutoApprovable(addedWrite, { enabled: true }), false)
    assert.equal(isAutoApprovable(addedWrite, { enabled: true, allowAddedWrite: true }), true)
  })

  await test('auto-jóváhagyás: meglévő WRITE endpoint új opcionális paramétere sem read-only addíció', () => {
    const before = extract(baseSpec({ '/orders': { post: { operationId: 'createOrder' } } }))
    const after = extract(baseSpec({ '/orders': { post: { operationId: 'createOrder', parameters: [
      { name: 'note', in: 'query', required: false, schema: { type: 'string' } },
    ] } } }))
    const diff = computeCapabilityDiff(before, after)
    assert.ok(diff.added.some((item) => item.change?.startsWith('optional_param_added_write:')))
    assert.equal(isAutoApprovable(diff, { enabled: true }), false)
  })

  await test('auto-jóváhagyás: bármely breaking/auth → mindig emberi kapu', () => {
    const risky = computeCapabilityDiff(V1, V2, deleteOrderUsed)
    assert.equal(isAutoApprovable(risky, { enabled: true, allowAddedWrite: true }), false)
  })

  // ── WP-2: szinkron-motor (fail-closed) ─────────────────────────────────────
  const okSpecText = JSON.stringify(
    baseSpec({ '/orders': { post: { operationId: 'createOrder' } } }),
  )

  function fakeFetch(body: string, init: { status?: number; contentType?: string; headers?: Record<string, string> } = {}) {
    return async () =>
      new Response(body, {
        status: init.status ?? 200,
        headers: { 'content-type': init.contentType ?? 'application/json', ...(init.headers ?? {}) },
      })
  }

  await test('szinkron OK: parse → capabilitySet + rawHash + host', async () => {
    const svc = new SpecSyncService({ fetchImpl: fakeFetch(okSpecText) })
    const r = await svc.sync('https://api.partner-crm.example/v1/openapi.json')
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.host, 'api.partner-crm.example')
    assert.equal(r.rawHash, specContentHash(okSpecText))
    assert.ok(r.capabilitySet.proposedTools.some((t) => t.method === 'POST' && t.path === '/orders'))
  })

  await test('fail-closed: SSRF host (metadata) → ssrf_blocked, nincs capabilitySet', async () => {
    const svc = new SpecSyncService({ fetchImpl: fakeFetch(okSpecText) })
    const r = await svc.sync('https://169.254.169.254/openapi.json')
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.reason, 'ssrf_blocked')
  })

  await test('fail-closed: http (nem https) → scheme_blocked', async () => {
    const svc = new SpecSyncService({ fetchImpl: fakeFetch(okSpecText) })
    const r = await svc.sync('http://api.partner-crm.example/v1/openapi.json')
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.reason, 'scheme_blocked')
  })

  await test('fail-closed: nem-OpenAPI tartalom → not_openapi', async () => {
    const svc = new SpecSyncService({ fetchImpl: fakeFetch('<html>not a spec</html>', { contentType: 'text/plain' }) })
    const r = await svc.sync('https://api.partner-crm.example/v1/openapi.json')
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.reason, 'not_openapi')
  })

  await test('fail-closed: nulla műveletes OpenAPI → empty_spec', async () => {
    const empty = JSON.stringify(baseSpec({}))
    const svc = new SpecSyncService({ fetchImpl: fakeFetch(empty) })
    const result = await svc.sync('https://api.partner-crm.example/openapi.json')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'empty_spec')
  })

  await test('MVP fail-closed: OAuth snapshot külön credential-migráció nélkül tiltott', async () => {
    const oauth = JSON.stringify({
      openapi: '3.0.3', info: { title: 'OAuth API', version: '1' },
      servers: [{ url: 'https://api.partner-crm.example/v1' }],
      components: { securitySchemes: { OAuth: { type: 'oauth2', flows: {
        authorizationCode: {
          authorizationUrl: 'https://api.partner-crm.example/oauth/authorize',
          tokenUrl: 'https://api.partner-crm.example/oauth/token', scopes: { read: 'Read' },
        },
      } } } }, security: [{ OAuth: ['read'] }],
      paths: { '/orders': { get: { operationId: 'listOrders' } } },
    })
    const svc = new SpecSyncService({ fetchImpl: fakeFetch(oauth) })
    const result = await svc.sync('https://api.partner-crm.example/openapi.json')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'unsupported_auth')
  })

  await test('fail-closed: a snapshot privát API-célhostja blokkolt', async () => {
    const privateTarget = JSON.stringify({
      ...baseSpec({ '/orders': { get: { operationId: 'listOrders' } } }),
      servers: [{ url: 'https://169.254.169.254/v1' }],
    })
    const svc = new SpecSyncService({ fetchImpl: fakeFetch(privateTarget) })
    const result = await svc.sync('https://api.partner-crm.example/openapi.json')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'ssrf_blocked')
  })

  await test('MVP formátum-kapu: Swagger 2.0 nem vehető át önfrissítő snapshotként', async () => {
    const swagger = JSON.stringify({
      swagger: '2.0', info: { title: 'Legacy', version: '1' }, host: 'partner.example',
      basePath: '/api', schemes: ['https'],
      securityDefinitions: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } },
      security: [{ ApiKey: [] }], paths: { '/ping': { get: { operationId: 'ping' } } },
    })
    const svc = new SpecSyncService({ fetchImpl: fakeFetch(swagger) })
    const result = await svc.sync('https://partner.example/openapi.json')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'not_openapi')
  })

  await test('fail-closed: túl nagy tartalom (content-length) → too_large', async () => {
    const svc = new SpecSyncService({
      fetchImpl: fakeFetch(okSpecText, { headers: { 'content-length': String(10_000_000) } }),
      limits: { maxBytes: 1000 },
    })
    const r = await svc.sync('https://api.partner-crm.example/v1/openapi.json')
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.reason, 'too_large')
  })

  await test('fail-closed: HTTP 500 → fetch_failed', async () => {
    const svc = new SpecSyncService({ fetchImpl: fakeFetch('err', { status: 500 }) })
    const r = await svc.sync('https://api.partner-crm.example/v1/openapi.json')
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.reason, 'fetch_failed')
  })

  await test('specContentHash determinisztikus és a változást megfogja', () => {
    assert.equal(specContentHash('a'), specContentHash('a'))
    assert.notEqual(specContentHash('a'), specContentHash('b'))
  })

  // ── WP-5: broker-enforcement az aktív snapshotból ─────────────────────────
  await test('self_updating connector aktív snapshot nélkül fail-closed', () => {
    assert.equal(pinnedRuntimeConfig('self_updating', V1, null), null)
    assert.equal(pinnedRuntimeConfig('self_updating', V1, { malformed: true }), null)
  })

  await test('a pinned snapshot endpoint-listája a kizárólagos runtime allowlist', async () => {
    const pinned = pinnedRuntimeConfig('self_updating', {}, V1)
    assert.ok(pinned)
    const client = new HttpApiClient(parseHttpApiConfig(pinned), { defaultApiKey: 'stub-key' })
    await assert.rejects(
      () => client.request({ method: 'GET', path: '/not-in-approved-snapshot' }),
      (error: unknown) => error instanceof HttpApiError && error.code === 'endpoint_not_allowed',
    )
  })

  await test('a pinned snapshot deklarált kötelező headere runtime-ban kikényszerített', async () => {
    const withHeader = extract(baseSpec({ '/reports': { get: {
      operationId: 'listReports',
      parameters: [{ name: 'X-Business-Unit', in: 'header', required: true, schema: { type: 'string' } }],
    } } }))
    const pinned = pinnedRuntimeConfig('self_updating', {}, withHeader)
    const client = new HttpApiClient(parseHttpApiConfig(pinned), { defaultApiKey: 'stub-key' })
    await assert.rejects(
      () => client.request({ method: 'GET', path: '/reports' }),
      (error: unknown) => error instanceof HttpApiError && error.code === 'required_header_missing',
    )
    await client.request({ method: 'GET', path: '/reports', headers: { 'X-Business-Unit': 'sales' } })
    await assert.rejects(
      () => client.request({ method: 'GET', path: '/reports', headers: { 'X-Undeclared': 'value' } }),
      (error: unknown) => error instanceof HttpApiError && error.code === 'header_not_allowed',
    )
  })

  await test('fixed connector runtime configja változatlan marad', () => {
    const fixed = { baseUrl: 'https://fixed.example', untouched: true }
    assert.equal(pinnedRuntimeConfig('fixed', fixed, null), fixed)
  })

  console.log('\n✅ Minden önfrissítő-connector teszt zöld')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})

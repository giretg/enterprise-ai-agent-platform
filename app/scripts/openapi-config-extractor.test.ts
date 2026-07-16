/**
 * OpenAPI → ConnectorConfig determinisztikus kinyerés.
 * Futtatás: npm run test:openapi-extractor
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  extractConnectorConfigFromOpenApiSpec,
  isOpenApiSpec,
  parseOpenApiDocumentSync,
  tryExtractConnectorConfigFromOpenApi,
} from '../src/domain/provisioning/openapi-config-extractor'

const MINIMAL_OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'Acme CRM API', version: '1.0.0' },
  servers: [{ url: 'https://api.acme-crm.example/v1' }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
    },
  },
  security: [{ ApiKeyAuth: ['contacts.read'] }],
  paths: {
    '/contacts': {
      get: {
        operationId: 'listContacts',
        summary: 'List contacts',
        security: [{ ApiKeyAuth: ['contacts.read'] }],
      },
      post: {
        operationId: 'createContact',
        summary: 'Create contact',
        security: [{ ApiKeyAuth: ['contacts.write'] }],
      },
    },
    '/contacts/{id}': {
      get: {
        operationId: 'getContact',
        security: [{ ApiKeyAuth: ['contacts.read'] }],
      },
    },
  },
}

const IDEMPOTENCY_OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'Ledger API', version: '1.0.0' },
  servers: [{ url: 'https://api.ledger.example/v1' }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
    },
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      },
    },
  },
  security: [{ ApiKeyAuth: ['ledger.write'] }],
  paths: {
    // Operation-szintű, KÖTELEZŐ Idempotency-Key → idempotent: true
    '/orders': {
      post: {
        operationId: 'createOrder',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
      },
      // GET-en még kötelező Idempotency-Key esetén se jelöljük (a runtime csak írásra injektál)
      get: {
        operationId: 'listOrders',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
      },
    },
    // $ref-elt paraméter → fel kell oldani
    '/orders/{id}': {
      patch: {
        operationId: 'updateOrder',
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
      },
      // Path-szintű paraméter minden operationre érvényes
      parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
      delete: { operationId: 'deleteOrder' },
    },
    // Idempotency-Key jelen van, de NEM kötelező → nem jelöljük
    '/events': {
      post: {
        operationId: 'createEvent',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }],
      },
    },
    // Írás fejléc-követelmény nélkül → nem idempotent
    '/webhooks': {
      post: { operationId: 'createWebhook' },
    },
  },
}

function toolByName(
  result: ReturnType<typeof tryExtractConnectorConfigFromOpenApi>,
  name: string,
) {
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('extract failed')
  const tool = result.config.proposedTools.find((t) => t.name === name)
  assert.ok(tool, `tool ${name} not found`)
  return tool
}

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
  console.log('OpenAPI config extractor — determinisztikus teszt\n')

  await test('isOpenApiSpec felismeri az OpenAPI 3.x-et', () => {
    assert.equal(isOpenApiSpec(MINIMAL_OPENAPI), true)
    assert.equal(isOpenApiSpec({ provider: 'x' }), false)
  })

  await test('parseOpenApiDocumentSync JSON-ből parse-ol', () => {
    const spec = parseOpenApiDocumentSync(JSON.stringify(MINIMAL_OPENAPI))
    assert.ok(spec)
    assert.equal(spec?.info && (spec.info as { title?: string }).title, 'Acme CRM API')
  })

  await test('tryExtractConnectorConfigFromOpenApi — minimál spec → ConnectorConfig', () => {
    const result = tryExtractConnectorConfigFromOpenApi(JSON.stringify(MINIMAL_OPENAPI), 'acme-crm')
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.config.provider, 'acme-crm')
    assert.equal(result.config.baseUrl, 'https://api.acme-crm.example/v1')
    assert.deepEqual(result.config.egressHosts, ['api.acme-crm.example'])
    assert.equal(result.config.auth.type, 'api_key_header')
    assert.equal(result.config.auth.headerName, 'X-Api-Key')
    assert.equal(result.config.authMode, 'service')
    assert.ok(result.config.scopesSuggested.includes('contacts.read'))
    assert.ok(result.config.scopesSuggested.includes('contacts.write'))
    assert.equal(result.config.proposedTools.length, 3)
    assert.deepEqual(
      result.config.proposedTools.find((t) => t.name === 'createContact'),
      {
        name: 'createContact',
        method: 'POST',
        path: '/contacts',
        access: 'write',
        description: 'Create contact',
      },
    )
  })

  await test('idempotencia: operation-szintű kötelező Idempotency-Key → idempotent: true', () => {
    const result = tryExtractConnectorConfigFromOpenApi(JSON.stringify(IDEMPOTENCY_OPENAPI), 'ledger')
    assert.equal(toolByName(result, 'createOrder').idempotent, true)
  })

  await test('idempotencia: $ref-elt paraméter feloldódik → idempotent: true', () => {
    const result = tryExtractConnectorConfigFromOpenApi(JSON.stringify(IDEMPOTENCY_OPENAPI), 'ledger')
    assert.equal(toolByName(result, 'updateOrder').idempotent, true)
  })

  await test('idempotencia: path-szintű paraméter minden operationre hat → deleteOrder idempotent', () => {
    const result = tryExtractConnectorConfigFromOpenApi(JSON.stringify(IDEMPOTENCY_OPENAPI), 'ledger')
    assert.equal(toolByName(result, 'deleteOrder').idempotent, true)
  })

  await test('idempotencia: nem kötelező Idempotency-Key → nem jelöljük', () => {
    const result = tryExtractConnectorConfigFromOpenApi(JSON.stringify(IDEMPOTENCY_OPENAPI), 'ledger')
    assert.equal(toolByName(result, 'createEvent').idempotent, undefined)
  })

  await test('idempotencia: fejléc-követelmény nélküli írás → nem idempotent', () => {
    const result = tryExtractConnectorConfigFromOpenApi(JSON.stringify(IDEMPOTENCY_OPENAPI), 'ledger')
    assert.equal(toolByName(result, 'createWebhook').idempotent, undefined)
  })

  await test('idempotencia: GET-en kötelező Idempotency-Key esetén sem jelöljük (runtime csak írásra injektál)', () => {
    const result = tryExtractConnectorConfigFromOpenApi(JSON.stringify(IDEMPOTENCY_OPENAPI), 'ledger')
    assert.equal(toolByName(result, 'listOrders').idempotent, undefined)
  })

  await test('próza doksi → not_openapi (LLM fallback)', () => {
    const result = tryExtractConnectorConfigFromOpenApi('Acme CRM API. GET /v1/contacts')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'not_openapi')
  })

  await test('Ostoros élő OpenAPI (ha elérhető) — 130 művelet', async () => {
    let raw: string
    try {
      raw = readFileSync('/tmp/ostoros-openapi.json', 'utf8')
    } catch {
      console.log('  (skip: /tmp/ostoros-openapi.json nem elérhető)')
      return
    }
    const result = tryExtractConnectorConfigFromOpenApi(raw, 'ostoros-fold')
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.config.provider, 'ostoros-fold')
    assert.equal(
      result.config.baseUrl,
      'https://ostoros-fold--enterprise-ai-demo.europe-west4.hosted.app/api/v1',
    )
    assert.equal(result.config.auth.headerName, 'X-API-Key')
    assert.equal(result.config.proposedTools.length, 130)
    assert.ok(result.config.scopesSuggested.includes('partners:read'))
    const createPartner = result.config.proposedTools.find((t) => t.name === 'createPartner')
    assert.ok(createPartner)
    // A regresszió lényege: az Ostoros spec minden íráshoz kötelező Idempotency-Key
    // fejlécet ír elő → a kinyerésnek idempotent: true-t kell adnia (ezt hagyta ki eddig).
    assert.equal(createPartner.idempotent, true)
    const writeTools = result.config.proposedTools.filter((t) => t.access === 'write')
    const idempotentWrites = writeTools.filter((t) => t.idempotent === true)
    assert.equal(idempotentWrites.length, 71, '71/73 írási művelet idempotens az Ostoros specben')
  })

  await test('extractConnectorConfigFromOpenApiSpec — hiányzó server → unsupported', () => {
    const result = extractConnectorConfigFromOpenApiSpec({ openapi: '3.0.0', paths: {} })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'unsupported')
  })

  console.log('\n✅ Minden OpenAPI extractor teszt zöld')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})

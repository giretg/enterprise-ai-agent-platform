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
    assert.ok(result.config.proposedTools.some((t) => t.name === 'createPartner'))
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

/**
 * OpenAPI → ConnectorConfig determinisztikus kinyerés.
 * Futtatás: npm run test:openapi-extractor
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  extractConnectorConfigFromOpenApiSpec,
  isOpenApiSpec,
  parseOpenApiDocument,
  parseOpenApiDocumentSync,
  tryExtractConnectorConfigFromOpenApi,
  tryExtractConnectorConfigFromOpenApiAsync,
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

const CURSOR_PAGINATION_OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'Cursor API', version: '1.0.0' },
  servers: [{ url: 'https://api.cursor.example/v1' }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
    },
    parameters: {
      Cursor: { name: 'cursor', in: 'query', schema: { type: 'string' } },
      Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } },
    },
    schemas: {
      SuccessEnvelope: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
      },
      ListMeta: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          nextCursor: { type: ['string', 'null'] },
        },
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
  paths: {
    '/accounts': {
      get: {
        operationId: 'listAccounts',
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Cursor page',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/SuccessEnvelope' },
                    {
                      type: 'object',
                      properties: {
                        data: { type: 'array', items: { type: 'object' } },
                        meta: { $ref: '#/components/schemas/ListMeta' },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
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

  await test('parseOpenApiDocument YAML — idézetlen openapi: 3.0 (js-yaml v5 number) felismerése', async () => {
    const yaml = [
      'openapi: 3.0',
      'info:',
      '  title: Acme YAML API',
      '  version: 1.0.0',
      'servers:',
      '  - url: https://api.acme-yaml.example/v1',
      'components:',
      '  securitySchemes:',
      '    ApiKeyAuth:',
      '      type: apiKey',
      '      in: header',
      '      name: X-Api-Key',
      'security:',
      '  - ApiKeyAuth: []',
      'paths:',
      '  /ping:',
      '    get:',
      '      operationId: ping',
      '      summary: Health',
    ].join('\n')
    const spec = await parseOpenApiDocument(yaml)
    assert.ok(spec)
    assert.equal(spec?.openapi, '3.0')
    const result = await tryExtractConnectorConfigFromOpenApiAsync(yaml, 'acme-yaml')
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.config.baseUrl, 'https://api.acme-yaml.example/v1')
  })

  await test('parseOpenApiDocument YAML — idézetlen swagger: 2.0 felismerése', async () => {
    const yaml = [
      'swagger: 2.0',
      'info:',
      '  title: Legacy API',
      '  version: 1.0.0',
      'host: api.legacy.example',
      'basePath: /v1',
      'schemes:',
      '  - https',
      'paths:',
      '  /ping:',
      '    get:',
      '      operationId: ping',
    ].join('\n')
    const spec = await parseOpenApiDocument(yaml)
    assert.ok(spec)
    assert.equal(spec?.swagger, '2.0')
  })

  await test('isOpenApiSpec elfogadja a YAML-ből jövő numerikus verziómezőket is', () => {
    assert.equal(isOpenApiSpec({ openapi: 3.0, paths: {} }), true)
    assert.equal(isOpenApiSpec({ openapi: 3.1, paths: {} }), true)
    assert.equal(isOpenApiSpec({ swagger: 2.0, paths: {} }), true)
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

  await test('cursoros OpenAPI → endpoint pagination capability', () => {
    const result = tryExtractConnectorConfigFromOpenApi(
      JSON.stringify(CURSOR_PAGINATION_OPENAPI),
      'cursor-api',
    )
    assert.deepEqual(toolByName(result, 'listAccounts').pagination, {
      kind: 'cursor',
      cursorParam: 'cursor',
      limitParam: 'limit',
      itemsPath: 'data',
      nextCursorPath: 'meta.nextCursor',
      totalPath: 'meta.total',
    })
  })

  await test('OpenAPI Link response header → next_link pagination capability', () => {
    const spec = structuredClone(CURSOR_PAGINATION_OPENAPI)
    const operation = spec.paths['/accounts'].get as unknown as {
      parameters: unknown[]
      responses: Record<string, unknown>
    }
    operation.parameters = []
    operation.responses['200'] = {
      description: 'Link-paginated page',
      headers: {
        Link: { schema: { type: 'string' }, description: 'RFC 8288 rel=next' },
      },
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { results: { type: 'array', items: { type: 'object' } } },
          },
        },
      },
    }
    const result = tryExtractConnectorConfigFromOpenApi(JSON.stringify(spec), 'link-api')
    assert.deepEqual(toolByName(result, 'listAccounts').pagination, {
      kind: 'next_link', itemsPath: 'results', linkHeaderRel: 'next',
    })

    const response = operation.responses['200'] as {
      headers: { Link: { description: string } }
    }
    response.headers.Link.description = 'Kapcsolódó erőforrások hivatkozásai'
    const unrelated = tryExtractConnectorConfigFromOpenApi(JSON.stringify(spec), 'link-api')
    assert.equal(toolByName(unrelated, 'listAccounts').pagination, undefined)
  })

  await test('page és offset query-konvenciók determinisztikusan felismerhetők', () => {
    const pageSpec = structuredClone(CURSOR_PAGINATION_OPENAPI)
    const pageOperation = pageSpec.paths['/accounts'].get as unknown as { parameters: unknown[] }
    pageOperation.parameters = [
      { name: 'page', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } },
      { name: 'per_page', in: 'query', schema: { type: 'integer', default: 25, maximum: 50 } },
    ]
    const page = tryExtractConnectorConfigFromOpenApi(JSON.stringify(pageSpec), 'page-api')
    assert.deepEqual(toolByName(page, 'listAccounts').pagination, {
      kind: 'page', pageParam: 'page', pageSizeParam: 'per_page', firstPage: 0,
      defaultPageSize: 25, maxPageSize: 50,
      itemsPath: 'data', totalPath: 'meta.total',
    })

    const offsetSpec = structuredClone(CURSOR_PAGINATION_OPENAPI)
    const offsetOperation = offsetSpec.paths['/accounts'].get as unknown as { parameters: unknown[] }
    offsetOperation.parameters = [
      { name: 'offset', in: 'query', schema: { type: 'integer', default: 1, minimum: 1 } },
      { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 40 } },
    ]
    const offset = tryExtractConnectorConfigFromOpenApi(JSON.stringify(offsetSpec), 'offset-api')
    assert.deepEqual(toolByName(offset, 'listAccounts').pagination, {
      kind: 'offset', offsetParam: 'offset', limitParam: 'limit', firstOffset: 1,
      maxPageSize: 40,
      itemsPath: 'data', totalPath: 'meta.total',
    })
  })

  await test('bizonytalan lista nem kap implicit none/page stratégiát', () => {
    const spec = structuredClone(CURSOR_PAGINATION_OPENAPI)
    const operation = spec.paths['/accounts'].get as unknown as {
      parameters: unknown[]
      'x-pagination'?: unknown
    }
    operation.parameters = [{ name: 'page', in: 'query', schema: { type: 'integer' } }]
    const uncertain = tryExtractConnectorConfigFromOpenApi(JSON.stringify(spec), 'uncertain-api')
    assert.equal(toolByName(uncertain, 'listAccounts').pagination, undefined)

    operation.parameters = []
    operation['x-pagination'] = { kind: 'none', itemsPath: 'data' }
    const explicit = tryExtractConnectorConfigFromOpenApi(JSON.stringify(spec), 'explicit-api')
    assert.deepEqual(toolByName(explicit, 'listAccounts').pagination, {
      kind: 'none', itemsPath: 'data',
    })
  })

  await test('x-action-class: read → POST risk:read (access továbbra is write)', () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Service Insight', version: '1.0.0' },
      servers: [{ url: 'https://crm.example/api/connector/v1' }],
      components: {
        securitySchemes: {
          BearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
      security: [{ BearerAuth: [] }],
      paths: {
        '/reports/query': {
          post: {
            operationId: 'queryReport',
            summary: 'Riportlekérdezés',
            'x-action-class': 'read',
            'x-write': false,
          },
        },
        '/reports/exports': {
          post: {
            operationId: 'exportReport',
            'x-write': false,
          },
        },
        '/accounts': {
          post: {
            operationId: 'createAccount',
            'x-action-class': 'write',
          },
        },
      },
    }
    const result = tryExtractConnectorConfigFromOpenApi(JSON.stringify(spec), 'ostoros-insight')
    assert.equal(result.ok, true)
    if (!result.ok) return
    const query = result.config.proposedTools.find((t) => t.path === '/reports/query')
    const exp = result.config.proposedTools.find((t) => t.path === '/reports/exports')
    const create = result.config.proposedTools.find((t) => t.path === '/accounts')
    assert.ok(query)
    assert.equal(query.method, 'POST')
    assert.equal(query.access, 'write')
    assert.equal(query.risk, 'read')
    assert.ok(exp)
    assert.equal(exp.access, 'write')
    assert.equal(exp.risk, 'read')
    assert.ok(create)
    assert.equal(create.risk, 'write')
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

  await test('generikus extractor megőrzi a connector-konfig nélkül nem injektált fejléceket', () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'CRM', version: '1.0.0' },
      servers: [{ url: 'https://crm.example/api/v1' }],
      components: {
        securitySchemes: {
          BearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
      security: [{ BearerAuth: [] }],
      paths: {
        '/orders': {
          get: {
            operationId: 'listOrders',
            parameters: [
              { name: 'X-Agent-Id', in: 'header', required: true, schema: { type: 'string' } },
              { name: 'X-Acting-User', in: 'header', required: true, schema: { type: 'string' } },
              { name: 'X-Connector-Call-Id', in: 'header', required: true, schema: { type: 'string' } },
              { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } },
              { name: 'period', in: 'query', required: true, schema: { type: 'string' } },
              { name: 'X-Request-Id', in: 'header', required: false, schema: { type: 'string' } },
            ],
          },
        },
      },
    }
    const result = tryExtractConnectorConfigFromOpenApi(JSON.stringify(spec), 'crm')
    assert.equal(result.ok, true)
    if (!result.ok) return
    const tool = result.config.proposedTools.find((t) => t.name === 'listOrders')
    assert.ok(tool)
    const params = tool.parameters ?? []
    assert.ok(params.some((p) => p.in === 'query' && p.name === 'period'))
    assert.ok(params.some((p) => p.in === 'header' && p.name === 'X-Request-Id'))
    for (const name of ['X-Agent-Id', 'X-Acting-User', 'X-Connector-Call-Id', 'Idempotency-Key']) {
      assert.ok(params.some((p) => p.in === 'header' && p.name === name), `${name} header hiányzik`)
    }
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

  await test('extractConnectorConfigFromOpenApiSpec — info.description → config.description', () => {
    const result = extractConnectorConfigFromOpenApiSpec({
      openapi: '3.0.0',
      info: { title: 'Banks API', description: 'Banki adatok olvasása.' },
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/banks': { get: { summary: 'List banks', responses: { 200: { description: 'ok' } } } },
      },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.config.description, 'Banki adatok olvasása.')
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

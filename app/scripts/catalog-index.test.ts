/**
 * Gyűjtőindex (katalógus) felismerés + leaf-kinyerés determinisztikus tesztek.
 * Futtatás: npm run test:catalog-index
 */
import assert from 'node:assert/strict'
import {
  extractCatalogLeaves,
  isCatalogIndexDocument,
  isSpecFilePath,
} from '../src/domain/connector-self-update/catalog-index'

function catalogDoc() {
  return {
    openapi: '3.1.0',
    info: { title: 'POSnavigator API Catalog', version: '1.0.0' },
    servers: [{ url: 'https://posnavigator.eu' }],
    paths: {
      '/openapi/catalog.yaml': { get: { operationId: 'getOpenApiCatalog' } },
      '/openapi/blogs.yaml': {
        get: { operationId: 'getBlogsOpenApi', summary: 'Blog OpenAPI' },
      },
      '/openapi/banks.yaml': { get: { operationId: 'getBanksOpenApi' } },
    },
  }
}

function blogsDoc() {
  return {
    openapi: '3.1.0',
    info: { title: 'POSnavigator Blog API', version: '1.0.0' },
    servers: [{ url: 'https://posnavigator.eu' }],
    paths: {
      '/openapi/blogs.yaml': { get: { operationId: 'getBlogsOpenApi' } },
      '/api/v1/blogs': { get: { operationId: 'listBlogs' } },
      '/api/v1/blogs/{blogId}': { get: { operationId: 'getBlog' } },
    },
  }
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
  await test('isSpecFilePath — yaml/yml/json igen, adat-path nem', () => {
    assert.equal(isSpecFilePath('/openapi/blogs.yaml'), true)
    assert.equal(isSpecFilePath('/openapi/spec.yml'), true)
    assert.equal(isSpecFilePath('/openapi.json'), true)
    assert.equal(isSpecFilePath('/api/v1/blogs'), false)
    assert.equal(isSpecFilePath('/api/v1/blogs/{blogId}'), false)
  })

  await test('csupa spec-path → katalógus', () => {
    assert.equal(isCatalogIndexDocument(catalogDoc()), true)
  })

  await test('adatműveletet is tartalmazó doc → nem katalógus', () => {
    assert.equal(isCatalogIndexDocument(blogsDoc()), false)
  })

  await test('üres / hiányzó / kevert paths → nem katalógus', () => {
    assert.equal(isCatalogIndexDocument({ openapi: '3.1.0', paths: {} }), false)
    assert.equal(isCatalogIndexDocument({ openapi: '3.1.0' }), false)
    assert.equal(
      isCatalogIndexDocument({ paths: { '/openapi/a.yaml': {}, '/api/v1/x': {} } }),
      false,
    )
    assert.equal(isCatalogIndexDocument(null), false)
  })

  await test('leaf-kinyerés: abszolút URL, név, summary; önmaga kihagyva', () => {
    const leaves = extractCatalogLeaves(catalogDoc(), 'https://posnavigator.eu/openapi/catalog.yaml')
    assert.equal(leaves.length, 2)
    const blogs = leaves.find((leaf) => leaf.name === 'blogs')
    assert.ok(blogs)
    assert.equal(blogs.specUrl, 'https://posnavigator.eu/openapi/blogs.yaml')
    assert.equal(blogs.summary, 'Blog OpenAPI')
    assert.ok(!leaves.some((leaf) => leaf.specUrl === 'https://posnavigator.eu/openapi/catalog.yaml'))
  })

  await test('leaf-kinyerés servers nélkül: a katalógus-URL originje az alap', () => {
    const doc = {
      openapi: '3.1.0',
      paths: { '/openapi/banks.yaml': { get: {} } },
    }
    const leaves = extractCatalogLeaves(doc, 'https://partner.example/specs/catalog.yaml')
    assert.equal(leaves.length, 1)
    assert.equal(leaves[0]?.specUrl, 'https://partner.example/openapi/banks.yaml')
  })

  await test('nem-katalógus doc → üres leaf-lista', () => {
    assert.deepEqual(extractCatalogLeaves(blogsDoc(), 'https://posnavigator.eu/openapi/blogs.yaml'), [])
  })
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})

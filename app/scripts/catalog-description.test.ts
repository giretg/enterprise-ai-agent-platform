/**
 * Futtatás: npm run test:catalog-description
 */
import assert from 'node:assert/strict'
import { describeConnectorCatalog } from '../src/domain/connector/catalog-description'

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}:`, error)
    process.exitCode = 1
  }
}

test('önfrissítő snapshot: OpenAPI info.description a katalógus-leírás', () => {
  const meta = describeConnectorCatalog('http_api', {}, {
    provider: 'banks',
    baseUrl: 'https://example.test/api',
    description: 'Banki adatok olvasása a POSnavigator API-n.',
    proposedTools: [{ name: 'list', method: 'GET', path: '/banks', access: 'read' }],
  })
  assert.equal(meta.description, 'Banki adatok olvasása a POSnavigator API-n.')
})

test('önfrissítő snapshot: üres config + capability → művelet-leírásokból összefoglaló', () => {
  const meta = describeConnectorCatalog('http_api', {}, {
    provider: 'blogs',
    baseUrl: 'https://example.test',
    proposedTools: [
      { name: 'a', method: 'GET', path: '/a', access: 'read', description: 'Első művelet.' },
      { name: 'b', method: 'GET', path: '/b', access: 'read', description: 'Második művelet.' },
    ],
  })
  assert.equal(meta.description, 'Első művelet. Második művelet.')
})

if (process.exitCode) {
  console.error('catalog-description: failures')
  process.exit(1)
}
console.log('catalog-description: ok')

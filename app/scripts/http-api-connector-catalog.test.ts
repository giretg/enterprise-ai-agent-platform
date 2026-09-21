/**
 * MCP / checkout connector API katalógus — tiszta függvény tesztek.
 * Futtatás: npx tsx scripts/http-api-connector-catalog.test.ts
 */
import assert from 'node:assert/strict'
import {
  buildAgentConnectorCatalog,
  buildHttpApiConnectorCatalogEntry,
  formatAgentConnectorCatalogMarkdown,
} from '../src/domain/connector/http-api-connector-catalog'

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

const CONNECTOR_ID = '88888888-8888-4888-8888-888888888888'

async function main() {
  console.log('\n=== http-api-connector-catalog ===\n')

  await check('http_api katalógus tartalmazza a dokumentált végpontokat', () => {
    const entry = buildHttpApiConnectorCatalogEntry({
      connector: {
        id: CONNECTOR_ID,
        name: 'Ostorosbor CRM',
        type: 'http_api',
        connectorMode: 'fixed',
        config: {
          baseUrl: 'https://crm.example/api/connector/v1',
          auth: { scheme: 'bearer' },
          description: 'Sales delegated CRM connector.',
          restrictToEndpoints: true,
          proposedTools: [
            {
              method: 'GET',
              path: '/quotes',
              access: 'read',
              description: 'Ajanlatlista lekerdezese.',
              queryParams: [{ name: 'limit', required: false, type: 'integer' }],
            },
            {
              method: 'POST',
              path: '/tasks',
              access: 'write',
              description: 'Follow-up teendo letrehozasa.',
            },
          ],
        },
      },
      accessMode: 'read',
    })
    assert.ok(entry)
    assert.equal(entry.endpoints.length, 2)
    assert.equal(entry.endpoints[0]?.path, '/quotes')
    assert.equal(entry.endpoints[0]?.callable, true)
    assert.equal(entry.endpoints[1]?.callable, false)
    assert.match(entry.guide, /GET \/quotes/)
    assert.match(entry.guide, /endpoint_not_allowed/)
    assert.match(entry.guide, /limit:integer/)
  })

  await check('agent katalógus összefoglaló nem engedi a végpont-találgatást', () => {
    const catalog = buildAgentConnectorCatalog([
      {
        connector: {
          id: CONNECTOR_ID,
          name: 'CRM',
          type: 'http_api',
          connectorMode: 'fixed',
          config: {
            baseUrl: 'https://crm.example/api/connector/v1',
            auth: { scheme: 'bearer' },
            proposedTools: [{ method: 'GET', path: '/quotes', access: 'read' }],
          },
        },
        accessMode: 'read',
      },
    ])
    assert.equal(catalog.connectors.length, 1)
    assert.match(catalog.summary, /ne találj ki végpontot/)
    const md = formatAgentConnectorCatalogMarkdown(catalog)
    assert.match(md, /## Connector API katalógus/)
    assert.match(md, /GET \/quotes/)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott\n`)
    process.exit(1)
  }
  console.log('\n✅ Minden teszt zöld\n')
}

main()

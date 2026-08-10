/**
 * WP-2 (B2, D-1/A) — a per-agent kulcs valóban hat futásidőben.
 * Futtatás: npm run test:http-api-per-agent-key
 *
 * DB és élő hálózat NÉLKÜL igazolja, hogy az `executeHttpApiTool`:
 *   - ha az agent-kötésen van per-agent alias (agentSecretAlias), azt oldja fel
 *     és azt injektálja Bearerként — az connector.authMode-tól függetlenül;
 *   - ha nincs, a connector-szintű (tenant) megosztott kulcs a fallback;
 *   - a két eset egyszerre él (agent A saját kulccsal, agent B a tenant-kulccsal).
 *
 * A hívást egy befecskendezett fetch-fake köti el; a kulcs env:NÉV aliasból oldódik.
 */
import assert from 'node:assert/strict'
import type { Connector } from '@prisma/client'
import { executeHttpApiTool } from '../src/domain/tool-broker/tool-broker-delegation'
import type { ToolBrokerService } from '../src/domain/tool-broker/tool-broker-service'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// A HTTP-úton az `executeHttpApiTool` nem használ semmit a service-ből, és
// actingUserId=null mellett DB-t sem érint — így üres self-fel is meghívható.
const dummySelf = {} as unknown as ToolBrokerService

function bearerConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'conn-crm',
    type: 'http_api',
    name: 'CRM',
    authMode: 'service',
    lifecycleState: 'active',
    scope: 'global',
    secretAlias: 'env:TENANT_KEY',
    version: 1,
    config: {
      baseUrl: 'https://crm.example/api/v1',
      auth: { scheme: 'bearer' },
      endpoints: [{ method: 'GET', path: '/accounts' }],
    },
    tenantId: 'tenant-A',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  } as Connector
}

/** Elköti a fetch-et és visszaadja az utolsó Authorization fejlécet. */
function installFetchCapture(): { lastAuth: () => string | undefined } {
  let captured: string | undefined
  ;(globalThis as { fetch: typeof fetch }).fetch = (async (
    _input: unknown,
    init?: { headers?: Record<string, string> },
  ) => {
    const headers = init?.headers ?? {}
    captured = headers.authorization ?? headers.Authorization
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ ok: true }),
    } as unknown as Response
  }) as typeof fetch

  return { lastAuth: () => captured }
}

// Hálózat nélküli DNS-feloldó: a futásidejű egress-őr publikus IP-t lát, így a fake
// fetch-ig eljut (a valós `node:dns` a `crm.example` hosztot nem oldaná fel a tesztben).
const publicHostResolver = async () => ['93.184.216.34']

async function callGet(connector: Connector, agentSecretAlias: string | null) {
  return executeHttpApiTool(
    dummySelf,
    {
      agentId: 'agent-x',
      agentVersion: 1,
      tool: 'http_api_get',
      args: { path: '/accounts' },
    },
    connector,
    'tenant-A',
    null, // actingUserId=null → nincs prisma.user lookup
    agentSecretAlias,
    undefined, // delegatedAccessToken
    publicHostResolver,
  )
}

async function main() {
  console.log('http_api per-agent key (WP-2)')

  process.env.AGENT_A_KEY = 'agent-a-secret'
  process.env.TENANT_KEY = 'tenant-shared-secret'
  delete process.env.HTTP_API_STUB
  const fetch = installFetchCapture()

  await test('agent A (per-agent kulccsal) az A-kulcsát használja — service módban is', async () => {
    const res = await callGet(bearerConnector(), 'env:AGENT_A_KEY')
    assert.equal(res.ok, true)
    assert.equal(fetch.lastAuth(), 'Bearer agent-a-secret')
  })

  await test('agent B (per-agent kulcs nélkül) a tenant-szintű kulcsot használja', async () => {
    const res = await callGet(bearerConnector(), null)
    assert.equal(res.ok, true)
    assert.equal(fetch.lastAuth(), 'Bearer tenant-shared-secret')
  })

  await test('a per-agent kulcs agent_owned módban is hat (visszafelé kompatibilis)', async () => {
    const res = await callGet(bearerConnector({ authMode: 'agent_owned' }), 'env:AGENT_A_KEY')
    assert.equal(res.ok, true)
    assert.equal(fetch.lastAuth(), 'Bearer agent-a-secret')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott.`)
    process.exit(1)
  }
  console.log('\nMinden per-agent-kulcs teszt zöld.')
}

void main()

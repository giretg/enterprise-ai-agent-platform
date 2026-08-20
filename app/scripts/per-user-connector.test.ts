/**
 * Determinisztikus teszt a per-user (delegált) connector-hozzáférés governance-magjához
 * (Feature-spec — Per-user Connector §6, §8, §10). Futtatás: npm run test:per-user-connector
 *
 * DB és élő hálózat NÉLKÜL igazolja a kétrétegű engedélyt (agent-capability + user-grant),
 * az acting-user szabályt, a scope-alapú least-privilege kaput, valamint a kötelező
 * negatív teszteket (§10.2 — G1, G2, G4, G5). A token-injektálást a Broker végzi; az
 * Authorizer csak engedélyt ad, nyers tokent sosem lát (G3 → architekturálisan kizárt).
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Agent,
  Connector,
  ConnectorGrant,
  ConnectorType,
  UserStatus,
} from '@prisma/client'
import { ConnectorGrantService } from '../src/domain/connector-grant/connector-grant-service'
import { createGrantTokenStore } from '../src/domain/connector-grant/grant-token-vault'
import {
  AllowlistAuthorizer,
  type ActingUserLookup,
  type RoleTemplateLookup,
} from '../src/domain/tool-broker/tool-broker-service'
import type {
  AgentRepository,
  AuditRepository,
  ConnectorGrantRepository,
  ToolBrokerRepository,
} from '../src/repositories/interfaces'
import {
  GMAIL_SCOPES,
  gmailToolAllowedByScopes,
  normalizeGmailScope,
  parseGmailScopes,
} from '../src/domain/connector-grant/gmail-scopes'

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

// ---- Fixture-építők ---------------------------------------------------------

function gmailConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'conn-gmail',
    type: 'gmail' as ConnectorType,
    name: 'Gmail (user delegált)',
    authMode: 'user_delegated',
    lifecycleState: 'active',
    scope: 'global',
    secretAlias: 'gmail-oauth-client',
    version: 1,
    config: { oauth: { scopes: ['gmail.readonly'] } },
    tenantId: 'tenant-A',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  } as Connector
}

function grant(overrides: Partial<ConnectorGrant> = {}): ConnectorGrant {
  return {
    id: 'grant-1',
    tenantId: 'tenant-A',
    connectorId: 'conn-gmail',
    userId: 'user-Y',
    status: 'active',
    scopes: [GMAIL_SCOPES.readonly],
    tokenRef: 'tenant/tenant-A/user/user-Y/connector/conn-gmail',
    accountLabel: 'y@example.com',
    grantedAt: new Date('2026-06-10T00:00:00.000Z'),
    expiresAt: null,
    lastRefreshedAt: null,
    revokedAt: null,
    ...overrides,
  } as ConnectorGrant
}

type FakeOpts = {
  capabilityAllowed?: boolean
  connector?: Connector | null
  grant?: ConnectorGrant | null | ((query: GrantQuery) => ConnectorGrant | null)
  userStatus?: UserStatus | 'missing'
  agentRole?: Agent['role']
  agentTenantId?: string | null
}

type GrantQuery = { tenantId: string | null; connectorId: string; userId: string }

function buildAuthorizer(opts: FakeOpts = {}) {
  const {
    capabilityAllowed = true,
    connector = gmailConnector(),
    grant: activeGrant = grant(),
    userStatus = 'active',
    agentRole = 'worker',
    agentTenantId = 'tenant-A',
  } = opts

  const grantQueries: GrantQuery[] = []

  const tools = {
    findCapability: async () =>
      capabilityAllowed ? { allowed: true } : { allowed: false },
    findConnectorForAgent: async () =>
      connector ? { connector, agentSecretAlias: null } : null,
  } as unknown as ToolBrokerRepository

  const agents = {
    findById: async () => ({ id: 'agent-1', role: agentRole, tenantId: agentTenantId }) as Agent,
  } as unknown as AgentRepository

  const grants = {
    findActiveGrant: async (q: GrantQuery) => {
      grantQueries.push(q)
      if (typeof activeGrant === 'function') return activeGrant(q)
      return activeGrant
    },
  } as unknown as ConnectorGrantRepository

  const lookupActingUser: ActingUserLookup = async () =>
    userStatus === 'missing' ? null : { status: userStatus }

  // §3.5: a szerep-sablon a tool-less invariáns adat-forrása. Determinisztikus
  // stub a kanonikus rendszer-sablonokkal (orchestrator = tool-less), hogy a teszt
  // hermetikus maradjon (ne a valós `role_templates` táblát kérdezze).
  const lookupRoleTemplate: RoleTemplateLookup = async (key) => ({
    toolAccessAllowed: key !== 'orchestrator',
  })

  const authorizer = new AllowlistAuthorizer(
    tools,
    agents,
    grants,
    lookupActingUser,
    lookupRoleTemplate,
  )
  return { authorizer, grantQueries }
}

function buildGrantService(initialGrant: ConnectorGrant | null = grant()) {
  let currentGrant: ConnectorGrant | null = initialGrant
  const created: Array<{ scopes: unknown; tenantId: string | null; connectorId: string; userId: string }> = []
  const auditEvents: unknown[] = []
  const grants = {
    findById: async (id: string) => (currentGrant?.id === id ? currentGrant : null),
    updateStatus: async (id: string, status: ConnectorGrant['status'], extra?: Partial<ConnectorGrant>) => {
      assert.equal(currentGrant?.id, id)
      currentGrant = { ...currentGrant, status, ...extra } as ConnectorGrant
      return currentGrant
    },
    findActiveGrant: async () => (currentGrant?.status === 'active' ? currentGrant : null),
    findByUser: async () => [],
    create: async (data: {
      tenantId: string | null
      connectorId: string
      userId: string
      scopes: unknown
      tokenRef: string
      accountLabel?: string | null
      expiresAt?: Date | null
    }) => {
      created.push({
        scopes: data.scopes,
        tenantId: data.tenantId,
        connectorId: data.connectorId,
        userId: data.userId,
      })
      currentGrant = {
        id: currentGrant?.id ?? 'grant-created',
        tenantId: data.tenantId,
        connectorId: data.connectorId,
        userId: data.userId,
        status: 'active',
        scopes: data.scopes as ConnectorGrant['scopes'],
        tokenRef: data.tokenRef,
        accountLabel: data.accountLabel ?? null,
        grantedAt: new Date(),
        expiresAt: data.expiresAt ?? null,
        lastRefreshedAt: null,
        revokedAt: null,
      } as ConnectorGrant
      return currentGrant
    },
    revokeAllForUser: async () => 0,
  } as unknown as ConnectorGrantRepository
  const audit = {
    append: async (event: unknown) => {
      auditEvents.push(event)
      return event
    },
  } as unknown as AuditRepository
  return { service: new ConnectorGrantService(grants, audit), auditEvents, created, getGrant: () => currentGrant }
}

// ---- §10.1 Funkcionális elfogadás ------------------------------------------

async function main() {
console.log('=== per-user connector: kétrétegű authorize ===')

await test('10.1.2 — capability + active grant + readonly scope → allowed, grant feloldva', async () => {
  const { authorizer, grantQueries } = buildAuthorizer()
  const result = await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'gmail_search',
    args: { query: 'invoice' },
    actingUserId: 'user-Y',
    tenantId: 'tenant-A',
  })
  assert.equal(result.allowed, true)
  if (result.allowed) {
    assert.equal(result.grant?.id, 'grant-1')
    assert.equal(result.actingUserId, 'user-Y')
  }
  // a grant a bejelentkezett user-re oldódik fel, az ő tenantjában
  assert.equal(grantQueries[0]?.tenantId, 'tenant-A')
  assert.equal(grantQueries[0]?.userId, 'user-Y')
  assert.equal(grantQueries[0]?.connectorId, 'conn-gmail')
})

await test('10.1.3a — capability nélkül → DENY (capability_not_allowed), nincs grant-feloldás', async () => {
  const { authorizer, grantQueries } = buildAuthorizer({ capabilityAllowed: false })
  const result = await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'gmail_search',
    actingUserId: 'user-Y',
  })
  assert.equal(result.allowed, false)
  if (!result.allowed) assert.equal(result.reason, 'capability_not_allowed')
  assert.equal(grantQueries.length, 0)
})

await test('10.1.3b — capability van, de grant nincs → DENY (connector_grant_missing)', async () => {
  const { authorizer } = buildAuthorizer({ grant: null })
  const result = await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'gmail_search',
    actingUserId: 'user-Y',
  })
  assert.equal(result.allowed, false)
  if (!result.allowed) assert.equal(result.reason, 'connector_grant_missing')
})

await test('10.1.7 — másik tenantból nincs grant-fallback → DENY (tenant_isolation)', async () => {
  const tenantAGrant = grant({ tenantId: 'tenant-A' })
  const { authorizer, grantQueries } = buildAuthorizer({
    connector: gmailConnector({ tenantId: 'tenant-B' }),
    grant: (query) => (query.tenantId === tenantAGrant.tenantId ? tenantAGrant : null),
  })
  const result = await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'gmail_search',
    actingUserId: 'user-Y',
    tenantId: 'tenant-B',
  })
  assert.equal(result.allowed, false)
  if (!result.allowed) assert.equal(result.reason, 'tenant_isolation')
  assert.equal(grantQueries.length, 0)
})

await test('TB-2 — tenant A agentje tenant B connectorát nem használhatja még hibás linkkel sem', async () => {
  const { authorizer, grantQueries } = buildAuthorizer({
    agentTenantId: 'tenant-A',
    connector: gmailConnector({ tenantId: 'tenant-B' }),
  })
  const result = await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'gmail_search',
    actingUserId: 'user-Y',
  })
  assert.equal(result.allowed, false)
  if (!result.allowed) assert.equal(result.reason, 'tenant_isolation')
  assert.equal(grantQueries.length, 0)
})

// ---- §10.2 Kötelező negatív tesztek ----------------------------------------

console.log('=== per-user connector: kötelező negatív tesztek (G1–G5) ===')

await test('G1 — Gmail-hívás acting_user nélkül (autonóm) → DENY (acting_user_required), nincs token-feloldás', async () => {
  const { authorizer, grantQueries } = buildAuthorizer()
  const result = await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'gmail_search',
    actingUserId: null,
  })
  assert.equal(result.allowed, false)
  if (!result.allowed) assert.equal(result.reason, 'acting_user_required')
  assert.equal(grantQueries.length, 0, 'acting_user nélkül nem szabad grantet feloldani')
})

await test('G2 — Y session: csak Y grantje oldódik fel, sosem egy másik user tokenje', async () => {
  const { authorizer, grantQueries } = buildAuthorizer()
  await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'gmail_search',
    actingUserId: 'user-Y',
    tenantId: 'tenant-A',
  })
  // a feloldás kizárólag a session acting-userére megy
  assert.equal(grantQueries.length, 1)
  assert.equal(grantQueries[0]?.userId, 'user-Y')
  assert.notEqual(grantQueries[0]?.userId, 'user-X')
})

await test('G4 — visszavont/lejárt grant (findActiveGrant → null) → DENY, nincs néma fallback', async () => {
  const { authorizer } = buildAuthorizer({ grant: null })
  const result = await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'gmail_search',
    actingUserId: 'user-Y',
  })
  assert.equal(result.allowed, false)
  if (!result.allowed) assert.equal(result.reason, 'connector_grant_missing')
})

await test('G5 — suspended user grantjének használata → DENY (acting_user_suspended)', async () => {
  const { authorizer, grantQueries } = buildAuthorizer({ userStatus: 'suspended' })
  const result = await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'gmail_search',
    actingUserId: 'user-Y',
  })
  assert.equal(result.allowed, false)
  if (!result.allowed) assert.equal(result.reason, 'acting_user_suspended')
  assert.equal(grantQueries.length, 0, 'suspended usernél a grant fel sem oldódik')
})

await test('G5b — ismeretlen acting_user (lookup → null) → DENY', async () => {
  const { authorizer } = buildAuthorizer({ userStatus: 'missing' })
  const result = await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'gmail_search',
    actingUserId: 'user-ghost',
  })
  assert.equal(result.allowed, false)
  if (!result.allowed) assert.equal(result.reason, 'acting_user_suspended')
})

// ---- §7.1 / §8 Least privilege — scope-kapu --------------------------------

console.log('=== per-user connector: scope-alapú least-privilege kapu ===')

await test('gmail_send csak readonly scope-pal → DENY (gmail_scope_not_granted)', async () => {
  const { authorizer } = buildAuthorizer({
    grant: grant({ scopes: [GMAIL_SCOPES.readonly] }),
  })
  const result = await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'gmail_send',
    args: { draftId: 'd1' },
    actingUserId: 'user-Y',
  })
  assert.equal(result.allowed, false)
  if (!result.allowed) assert.equal(result.reason, 'gmail_scope_not_granted')
})

await test('gmail_send send scope-pal → allowed (a human-kapu külön, a Broker.invoke-ban)', async () => {
  const { authorizer } = buildAuthorizer({
    grant: grant({ scopes: [GMAIL_SCOPES.send, GMAIL_SCOPES.readonly] }),
  })
  const result = await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'gmail_send',
    args: { draftId: 'd1' },
    actingUserId: 'user-Y',
  })
  assert.equal(result.allowed, true)
})

await test('orchestrator agent nem kap Gmail tool-t (tool-less) → DENY', async () => {
  const { authorizer } = buildAuthorizer({ agentRole: 'orchestrator' })
  const result = await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'gmail_search',
    actingUserId: 'user-Y',
  })
  assert.equal(result.allowed, false)
  if (!result.allowed) assert.equal(result.reason, 'orchestrator_tool_less')
})

// ---- Generikus http_api delegált (auto-consent, nem-Gmail) -----------------

console.log('=== generikus http_api delegált (auto-consent) ===')

function httpApiDelegatedConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'conn-crm',
    type: 'http_api' as ConnectorType,
    name: 'Provider CRM (delegált)',
    authMode: 'user_delegated',
    lifecycleState: 'active',
    scope: 'global',
    secretAlias: 'secret-ref:conn-crm',
    version: 1,
    config: {
      baseUrl: 'https://crm.example.com/api',
      auth: { scheme: 'bearer' },
      oauth: {
        authUrl: 'https://crm.example.com/oauth/authorize',
        tokenUrl: 'https://crm.example.com/oauth/token',
        clientId: 'crm-client-id',
        scopes: ['crm.read', 'crm.write'],
      },
    },
    tenantId: 'tenant-A',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  } as Connector
}

await test('http_api delegált: capability + active grant → allowed, nincs Gmail scope-kapu', async () => {
  const { authorizer } = buildAuthorizer({
    connector: httpApiDelegatedConnector(),
    grant: grant({ connectorId: 'conn-crm', scopes: ['crm.read'] }),
  })
  const result = await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'http_api_get',
    args: { path: '/customers' },
    actingUserId: 'user-Y',
    tenantId: 'tenant-A',
  })
  assert.equal(result.allowed, true)
  if (result.allowed) {
    assert.equal(result.connector?.id, 'conn-crm')
    assert.equal(result.grant?.id, 'grant-1')
    assert.equal(result.actingUserId, 'user-Y')
  }
})

await test('http_api delegált: acting_user nélkül (autonóm) → DENY (acting_user_required)', async () => {
  const { authorizer, grantQueries } = buildAuthorizer({
    connector: httpApiDelegatedConnector(),
    grant: grant({ connectorId: 'conn-crm' }),
  })
  const result = await authorizer.authorize({
    agentId: 'agent-1',
    tool: 'http_api_get',
    args: { path: '/customers' },
    actingUserId: null,
  })
  assert.equal(result.allowed, false)
  if (!result.allowed) assert.equal(result.reason, 'acting_user_required')
  assert.equal(grantQueries.length, 0)
})

await test('buildAuthorizationUrl: generikus provider a config.oauth-ot használja (nincs Google-default, nincs access_type)', async () => {
  const { service } = buildGrantService()
  const { url } = await service.buildAuthorizationUrl({
    connector: httpApiDelegatedConnector(),
    userId: 'user-Y',
    tenantId: 'tenant-A',
  })
  const parsed = new URL(url)
  assert.equal(`${parsed.origin}${parsed.pathname}`, 'https://crm.example.com/oauth/authorize')
  assert.equal(parsed.searchParams.get('client_id'), 'crm-client-id')
  // a generikus scope-ok érintetlenek maradnak (nincs Gmail-abbreviálás)
  assert.equal(parsed.searchParams.get('scope'), 'crm.read crm.write')
  // access_type=offline Google-specifikus — más providernél nem kerül bele
  assert.equal(parsed.searchParams.get('access_type'), null)
  assert.equal(parsed.searchParams.get('include_granted_scopes'), null)
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(parsed.searchParams.get('prompt'), 'consent')
  assert.ok(parsed.searchParams.get('redirect_uri')?.endsWith('/api/connectors/oauth/callback'))
})

await test('buildAuthorizationUrl: hiányzó config.oauth (nem-Google) → érthető hiba', async () => {
  const { service } = buildGrantService()
  await assert.rejects(
    () =>
      service.buildAuthorizationUrl({
        connector: httpApiDelegatedConnector({ config: { baseUrl: 'https://crm.example.com/api', auth: { scheme: 'bearer' } } as unknown as Connector['config'] }),
        userId: 'user-Y',
        tenantId: 'tenant-A',
      }),
    /missing authUrl/,
  )
})

await test('buildAuthorizationUrl: Google/Gmail connector explicit configból kap access_type=offline-t', async () => {
  const { service } = buildGrantService()
  const { url } = await service.buildAuthorizationUrl({
    connector: gmailConnector({
      config: {
        oauth: {
          authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          clientId: 'gmail-client',
          scopes: ['gmail.readonly'],
          offlineParams: { access_type: 'offline' },
          scopeTransform: 'gmailAlias',
        },
      } as unknown as Connector['config'],
    }),
    userId: 'user-Y',
    tenantId: 'tenant-A',
  })
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get('access_type'), 'offline')
  assert.equal(parsed.searchParams.get('include_granted_scopes'), 'true')
  // a Gmail scope-alias teljes URL-re normalizálódik
  assert.equal(parsed.searchParams.get('scope'), GMAIL_SCOPES.readonly)
})

await test('buildAuthorizationUrl: Gmail saját clientId nélkül a GMAIL_OAUTH_* env-et használja', async () => {
  const prevId = process.env.GMAIL_OAUTH_CLIENT_ID
  const prevSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET
  const prevRedirect = process.env.GMAIL_OAUTH_REDIRECT_URI
  process.env.GMAIL_OAUTH_CLIENT_ID = 'env-gmail-client'
  process.env.GMAIL_OAUTH_CLIENT_SECRET = 'env-gmail-secret'
  process.env.GMAIL_OAUTH_REDIRECT_URI = 'https://app.example/api/connectors/oauth/callback'
  try {
    const { service } = buildGrantService()
    const { url } = await service.buildAuthorizationUrl({
      connector: gmailConnector({
        config: {
          oauth: {
            authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: ['gmail.readonly'],
            offlineParams: { access_type: 'offline' },
            scopeTransform: 'gmailAlias',
          },
        } as unknown as Connector['config'],
      }),
      userId: 'user-Y',
      tenantId: 'tenant-A',
    })
    const parsed = new URL(url)
    assert.equal(parsed.searchParams.get('client_id'), 'env-gmail-client')
    assert.equal(
      parsed.searchParams.get('redirect_uri'),
      'https://app.example/api/connectors/oauth/callback',
    )
  } finally {
    if (prevId === undefined) delete process.env.GMAIL_OAUTH_CLIENT_ID
    else process.env.GMAIL_OAUTH_CLIENT_ID = prevId
    if (prevSecret === undefined) delete process.env.GMAIL_OAUTH_CLIENT_SECRET
    else process.env.GMAIL_OAUTH_CLIENT_SECRET = prevSecret
    if (prevRedirect === undefined) delete process.env.GMAIL_OAUTH_REDIRECT_URI
    else process.env.GMAIL_OAUTH_REDIRECT_URI = prevRedirect
  }
})

await test('buildAuthorizationUrl: Gmail saját clientId-jét a GMAIL_OAUTH_* nem írja felül', async () => {
  const prevId = process.env.GMAIL_OAUTH_CLIENT_ID
  const prevSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET
  process.env.GMAIL_OAUTH_CLIENT_ID = 'env-gmail-client'
  process.env.GMAIL_OAUTH_CLIENT_SECRET = 'env-gmail-secret'
  try {
    const { service } = buildGrantService()
    const { url } = await service.buildAuthorizationUrl({
      connector: gmailConnector({
        config: {
          oauth: {
            authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            clientId: 'connector-gmail-client',
            scopes: ['gmail.readonly'],
            offlineParams: { access_type: 'offline' },
            scopeTransform: 'gmailAlias',
          },
        } as unknown as Connector['config'],
      }),
      userId: 'user-Y',
      tenantId: 'tenant-A',
    })
    const parsed = new URL(url)
    assert.equal(parsed.searchParams.get('client_id'), 'connector-gmail-client')
  } finally {
    if (prevId === undefined) delete process.env.GMAIL_OAUTH_CLIENT_ID
    else process.env.GMAIL_OAUTH_CLIENT_ID = prevId
    if (prevSecret === undefined) delete process.env.GMAIL_OAUTH_CLIENT_SECRET
    else process.env.GMAIL_OAUTH_CLIENT_SECRET = prevSecret
  }
})

await test('buildAuthorizationUrl: Google provisioning descriptor explicit auth mezőiből épít consent URL-t', async () => {
  const { service } = buildGrantService()
  const { url } = await service.buildAuthorizationUrl({
    connector: httpApiDelegatedConnector({
      config: {
        provider: 'google_search_console',
        auth: {
          type: 'oauth2',
          authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          clientId: 'search-console-client',
          scope: 'https://www.googleapis.com/auth/webmasters.readonly',
          offlineParams: { access_type: 'offline' },
        },
      } as unknown as Connector['config'],
    }),
    userId: 'user-Y',
    tenantId: 'tenant-A',
  })
  const parsed = new URL(url)
  assert.equal(`${parsed.origin}${parsed.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(parsed.searchParams.get('client_id'), 'search-console-client')
  assert.equal(parsed.searchParams.get('scope'), 'https://www.googleapis.com/auth/webmasters.readonly')
  assert.equal(parsed.searchParams.get('access_type'), 'offline')
})

await test('buildAuthorizationUrl: Google API host alapján sem defaultolja az authUrl-t', async () => {
  const { service } = buildGrantService()
  await assert.rejects(
    () =>
      service.buildAuthorizationUrl({
        connector: httpApiDelegatedConnector({
          config: {
            provider: 'search-console',
            baseUrl: 'https://searchconsole.googleapis.com/webmasters/v3',
            egressHosts: ['searchconsole.googleapis.com'],
            auth: {
              type: 'oauth2',
              tokenUrl: 'https://oauth2.googleapis.com/token',
              clientId: 'search-console-client',
              scope: 'https://www.googleapis.com/auth/webmasters.readonly',
            },
          } as unknown as Connector['config'],
        }),
        userId: 'user-Y',
        tenantId: 'tenant-A',
      }),
    /missing authUrl/,
  )
})

await test('buildAuthorizationUrl: Search Console üres scopesSuggested mellett nem talál ki scope-ot', async () => {
  const { service } = buildGrantService()
  await assert.rejects(
    () =>
      service.buildAuthorizationUrl({
        connector: httpApiDelegatedConnector({
          config: {
            provider: 'search-console',
            baseUrl: 'https://searchconsole.googleapis.com/webmasters/v3',
            egressHosts: ['searchconsole.googleapis.com'],
            authMode: 'user_delegated',
            auth: {
              type: 'oauth2',
              authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
              tokenUrl: 'https://oauth2.googleapis.com/token',
              clientId: 'search-console-client',
            },
            scopesSuggested: [],
          } as unknown as Connector['config'],
        }),
        userId: 'user-Y',
        tenantId: 'tenant-A',
      }),
    /missing scopes/,
  )
})

await test('completeOAuthCallback: újra-consent uniózza a meglévő grant scope-jait (nem írja felül)', async () => {
  const prevStub = process.env.CONNECTOR_OAUTH_STUB
  process.env.CONNECTOR_OAUTH_STUB = 'true'
  try {
    const existing = grant({
      scopes: [GMAIL_SCOPES.readonly, GMAIL_SCOPES.modify],
    })
    const { service, created, getGrant } = buildGrantService(existing)
    const connector = gmailConnector({
      config: {
        oauth: {
          authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          clientId: 'gmail-client',
          scopes: [GMAIL_SCOPES.readonly, GMAIL_SCOPES.modify, GMAIL_SCOPES.send],
          scopeTransform: 'gmailAlias',
        },
      } as unknown as Connector['config'],
    })
    const { createOAuthState } = await import('../src/lib/crypto/oauth-state')
    const { state } = createOAuthState({
      userId: 'user-Y',
      connectorId: connector.id,
      tenantId: 'tenant-A',
      requestedScopes: [GMAIL_SCOPES.send],
    })
    await service.completeOAuthCallback({
      code: 'stub-auth-code',
      state,
      connector,
      actorId: 'user-Y',
    })
    assert.equal(created.length, 1)
    const scopes = created[0]?.scopes
    assert.ok(Array.isArray(scopes))
    assert.ok((scopes as string[]).includes(GMAIL_SCOPES.readonly))
    assert.ok((scopes as string[]).includes(GMAIL_SCOPES.modify))
    assert.ok((scopes as string[]).includes(GMAIL_SCOPES.send))
    assert.deepEqual(
      [...((getGrant()?.scopes as string[]) ?? [])].sort(),
      [GMAIL_SCOPES.modify, GMAIL_SCOPES.readonly, GMAIL_SCOPES.send].sort(),
    )
  } finally {
    if (prevStub === undefined) delete process.env.CONNECTOR_OAUTH_STUB
    else process.env.CONNECTOR_OAUTH_STUB = prevStub
  }
})

// ---- Grant token vault / service-invariáns ---------------------------------

console.log('=== connector grant service: token ownership invariant ===')

const grantTokenDir = await mkdtemp(join(tmpdir(), 'connector-grant-test-'))
process.env.CONNECTOR_GRANT_TOKEN_DIR = grantTokenDir

await test('resolveAccessToken csak egyező user+tenant+connector+tokenRef mellett ad ki tokent', async () => {
  const activeGrant = grant({
    expiresAt: new Date(Date.now() + 3600_000),
  })
  const { service } = buildGrantService(activeGrant)
  await createGrantTokenStore(activeGrant.tokenRef).save({
    accessToken: 'access-for-user-y',
    refreshToken: 'refresh-for-user-y',
    expiresAt: activeGrant.expiresAt?.toISOString() ?? null,
    scopes: [GMAIL_SCOPES.readonly],
  })

  const accessToken = await service.resolveAccessToken({
    connector: gmailConnector(),
    grantId: activeGrant.id,
    tokenRef: activeGrant.tokenRef,
    actingUserId: activeGrant.userId,
    tenantId: activeGrant.tenantId,
  })
  assert.equal(accessToken, 'access-for-user-y')
})

await test('resolveAccessToken idegen acting_user esetén DENY, tokenkiadás nélkül', async () => {
  const activeGrant = grant()
  const { service } = buildGrantService(activeGrant)
  await assert.rejects(
    () =>
      service.resolveAccessToken({
        connector: gmailConnector(),
        grantId: activeGrant.id,
        tokenRef: activeGrant.tokenRef,
        actingUserId: 'user-X',
        tenantId: activeGrant.tenantId,
      }),
    /connector_grant_forbidden/,
  )
})

await test('resolveAccessToken tokenRef-csere esetén DENY', async () => {
  const activeGrant = grant()
  const { service } = buildGrantService(activeGrant)
  await assert.rejects(
    () =>
      service.resolveAccessToken({
        connector: gmailConnector(),
        grantId: activeGrant.id,
        tokenRef: 'tenant/tenant-A/user/user-X/connector/conn-gmail',
        actingUserId: activeGrant.userId,
        tenantId: activeGrant.tenantId,
      }),
    /connector_grant_forbidden/,
  )
})

await test('resolveAccessToken elérhetetlen token-tároló esetén a grantot expired-re állítja', async () => {
  const activeGrant = grant({
    expiresAt: new Date(Date.now() + 3600_000),
    tokenRef: 'tenant/tenant-A/user/user-Y/connector/conn-gmail-vanished',
  })
  const { service, auditEvents } = buildGrantService(activeGrant)
  // A token-tárolóba semmit nem mentünk: a store.load() ENOENT-tel bukik,
  // mintha a grant a mai store-hoz képest egy korábbi tárolóban született volna.
  await assert.rejects(
    () =>
      service.resolveAccessToken({
        connector: gmailConnector(),
        grantId: activeGrant.id,
        tokenRef: activeGrant.tokenRef,
        actingUserId: activeGrant.userId,
        tenantId: activeGrant.tenantId,
      }),
    /grant_token_expired/,
  )
  const expiry = auditEvents.at(-1) as { action: string; metadata: { reason: string } }
  assert.equal(expiry.action, 'connector.grant.expire')
  assert.equal(expiry.metadata.reason, 'token_unavailable')

  // a grant nem maradhat active — a következő hívás már a státusz-kapun akad fenn
  await assert.rejects(
    () =>
      service.resolveAccessToken({
        connector: gmailConnector(),
        grantId: activeGrant.id,
        tokenRef: activeGrant.tokenRef,
        actingUserId: activeGrant.userId,
        tenantId: activeGrant.tenantId,
      }),
    /connector_grant_not_active/,
  )
})

await test('resolveAccessToken múló store-hibán NEM égeti el a grantot', async () => {
  const tokenRef = 'tenant/tenant-A/user/user-Y/connector/conn-gmail-unreadable'
  const activeGrant = grant({ expiresAt: new Date(Date.now() + 3600_000), tokenRef })
  const { service, auditEvents } = buildGrantService(activeGrant)
  // Könyvtár a token-fájl helyén → EISDIR: a tároló elérhetetlen, de a token nem "hiányzik".
  await mkdir(join(grantTokenDir, `${tokenRef}.json`), { recursive: true })

  await assert.rejects(
    () =>
      service.resolveAccessToken({
        connector: gmailConnector(),
        grantId: activeGrant.id,
        tokenRef: activeGrant.tokenRef,
        actingUserId: activeGrant.userId,
        tenantId: activeGrant.tenantId,
      }),
    /EISDIR/,
  )
  assert.equal(
    auditEvents.some((e) => (e as { action: string }).action === 'connector.grant.expire'),
    false,
  )
})

// ---- gmail-scopes tiszta logika (§7.1 mátrix) ------------------------------

console.log('=== gmail-scopes: tiszta scope-mátrix ===')

await test('readonly fedi a search/get_message-et, de nem a draftot/send-et', () => {
  const scopes = [GMAIL_SCOPES.readonly]
  assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_search', scopes }), true)
  assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_get_message', scopes }), true)
  assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_create_draft', scopes }), false)
  assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_send', scopes }), false)
})

await test('modify fedi az olvasást és a draftot, de nem a send-et', () => {
  const scopes = [GMAIL_SCOPES.modify]
  assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_search', scopes }), true)
  assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_create_draft', scopes }), true)
  assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_send', scopes }), false)
})

await test('send scope csak a küldést fedi (olvasást nem)', () => {
  const scopes = [GMAIL_SCOPES.send]
  assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_send', scopes }), true)
  assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_search', scopes }), false)
})

await test('full (mail.google.com) minden tool-t fed', () => {
  const scopes = [GMAIL_SCOPES.full]
  for (const tool of ['gmail_search', 'gmail_get_message', 'gmail_create_draft', 'gmail_send'] as const) {
    assert.equal(gmailToolAllowedByScopes({ tool, scopes }), true)
  }
})

await test('üres scope-lista → minden tiltott', () => {
  assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_search', scopes: [] }), false)
  assert.equal(gmailToolAllowedByScopes({ tool: 'gmail_search', scopes: null }), false)
})

await test('rövidített scope-alias normalizálódik a teljes URL-re', () => {
  assert.equal(normalizeGmailScope('gmail.readonly'), GMAIL_SCOPES.readonly)
  assert.deepEqual(parseGmailScopes(['gmail.send', 'gmail.readonly']), [
    GMAIL_SCOPES.send,
    GMAIL_SCOPES.readonly,
  ])
})

// ---- Összegzés --------------------------------------------------------------

if (failures > 0) {
  console.error(`\n❌ ${failures} teszt elbukott`)
  process.exit(1)
}
console.log('\n✅ minden per-user connector teszt zöld')
}

void main()

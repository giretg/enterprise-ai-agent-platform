/**
 * Több kapcsolt fiók OAuth: foglalt becenév, e-mail nélküli újra-consent, új token-ref.
 * Futtatás: npm run test:linked-account
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Connector, ConnectorGrant } from '@prisma/client'
import { ConnectorGrantService } from '../src/domain/connector-grant/connector-grant-service'
import { createGrantTokenStore } from '../src/domain/connector-grant/grant-token-vault'
import { GMAIL_SCOPES } from '../src/domain/connector-grant/gmail-scopes'
import { createOAuthState } from '../src/lib/crypto/oauth-state'
import type { ConnectorGrantRepository } from '../src/repositories/interfaces'

process.env.DATABASE_URL ??= 'postgresql://stub:stub@127.0.0.1:5432/stub'

function gmailConnector(scopes: string[]): Connector {
  return {
    id: 'conn-gmail',
    type: 'gmail',
    name: 'Gmail',
    authMode: 'user_delegated',
    lifecycleState: 'active',
    scope: 'global',
    secretAlias: 'gmail-oauth-client',
    version: 1,
    config: {
      oauth: {
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientId: 'gmail-client',
        scopes,
        scopeTransform: 'gmailAlias',
      },
    },
    tenantId: 'tenant-A',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
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
    nickname: null,
    grantedAt: new Date('2026-06-10T00:00:00.000Z'),
    expiresAt: null,
    lastRefreshedAt: null,
    revokedAt: null,
    ...overrides,
  } as ConnectorGrant
}

function buildGrantService(
  initial: ConnectorGrant | null,
  resolveEgressAllowlist?: (tenantId: string | null) => Promise<string[]>,
) {
  let currentGrant: ConnectorGrant | null = initial
  const created: Array<{ tokenRef: string; nickname: string | null; accountLabel: string | null }> = []
  const statusUpdates: Array<{ id: string; status: ConnectorGrant['status'] }> = []
  const grants = {
    findById: async (id: string) => (currentGrant?.id === id ? currentGrant : null),
    updateStatus: async (id: string, status: ConnectorGrant['status']) => {
      statusUpdates.push({ id, status })
      if (currentGrant?.id === id) currentGrant = { ...currentGrant, status }
      return currentGrant as ConnectorGrant
    },
    findActiveGrant: async () => (currentGrant?.status === 'active' ? currentGrant : null),
    findActiveGrants: async () => (currentGrant?.status === 'active' ? [currentGrant] : []),
    findByUser: async () =>
      currentGrant
        ? [
            {
              ...currentGrant,
              connector: {
                id: currentGrant.connectorId,
                name: 'Gmail',
                type: 'gmail',
                lifecycleState: 'active' as const,
              },
            },
          ]
        : [],
    updateNickname: async () => currentGrant as ConnectorGrant,
    create: async (data: {
      tenantId: string
      connectorId: string
      userId: string
      scopes: unknown
      tokenRef: string
      accountLabel?: string | null
      nickname?: string | null
      expiresAt?: Date | null
    }) => {
      created.push({
        tokenRef: data.tokenRef,
        nickname: data.nickname ?? null,
        accountLabel: data.accountLabel ?? null,
      })
      const sameAccount =
        currentGrant &&
        data.accountLabel &&
        currentGrant.accountLabel?.toLowerCase() === data.accountLabel.toLowerCase()
      const sameToken = currentGrant && currentGrant.tokenRef === data.tokenRef
      const reuse = Boolean(sameAccount || sameToken)
      currentGrant = {
        id: reuse && currentGrant ? currentGrant.id : 'grant-created',
        tenantId: data.tenantId,
        connectorId: data.connectorId,
        userId: data.userId,
        status: 'active',
        scopes: data.scopes as ConnectorGrant['scopes'],
        tokenRef: data.tokenRef,
        accountLabel: data.accountLabel ?? null,
        nickname: data.nickname ?? (reuse ? currentGrant?.nickname : null) ?? null,
        grantedAt: new Date(),
        expiresAt: data.expiresAt ?? null,
        lastRefreshedAt: null,
        revokedAt: null,
      } as ConnectorGrant
      return currentGrant
    },
    revokeAllForUser: async () => 0,
  } as unknown as ConnectorGrantRepository
  return {
    service: new ConnectorGrantService(grants, resolveEgressAllowlist),
    created,
    getGrant: () => currentGrant,
    statusUpdates,
  }
}

async function withGoogleTokenResponse<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  const prevFetch = globalThis.fetch
  const prevStub = process.env.CONNECTOR_OAUTH_STUB
  const prevGmailStub = process.env.GMAIL_OAUTH_STUB
  const prevSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET
  delete process.env.CONNECTOR_OAUTH_STUB
  delete process.env.GMAIL_OAUTH_STUB
  process.env.GMAIL_OAUTH_CLIENT_SECRET = 'test-gmail-secret'
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === 'https://oauth2.googleapis.com/token') {
      return new Response(
        JSON.stringify({
          access_token: 'ya29.access',
          refresh_token: '1//refresh',
          expires_in: 3600,
          scope,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`unexpected fetch: ${String(input)}`)
  }) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = prevFetch
    if (prevStub === undefined) delete process.env.CONNECTOR_OAUTH_STUB
    else process.env.CONNECTOR_OAUTH_STUB = prevStub
    if (prevGmailStub === undefined) delete process.env.GMAIL_OAUTH_STUB
    else process.env.GMAIL_OAUTH_STUB = prevGmailStub
    if (prevSecret === undefined) delete process.env.GMAIL_OAUTH_CLIENT_SECRET
    else process.env.GMAIL_OAUTH_CLIENT_SECRET = prevSecret
  }
}

async function main() {
  process.env.CONNECTOR_GRANT_TOKEN_DIR = await mkdtemp(join(tmpdir(), 'linked-account-oauth-'))

{
  const prevStub = process.env.CONNECTOR_OAUTH_STUB
  process.env.CONNECTOR_OAUTH_STUB = 'true'
  try {
    const existing = grant({ nickname: 'Magán', accountLabel: 'anna@gmail.com' })
    const { service, created, getGrant } = buildGrantService(existing)
    const connector = gmailConnector([GMAIL_SCOPES.readonly])
    await assert.rejects(
      () =>
        service.startUserAuthorization({
          connector,
          userId: 'user-Y',
          tenantId: 'tenant-A',
          isAdmin: false,
          requestedScopes: [GMAIL_SCOPES.readonly],
          nickname: 'Magán',
          addAccount: true,
        }),
      /nickname_taken/,
    )
    assert.equal(created.length, 0)
    assert.equal(getGrant()?.id, existing.id)

    const { state } = createOAuthState({
      userId: 'user-Y',
      connectorId: connector.id,
      tenantId: 'tenant-A',
      requestedScopes: [GMAIL_SCOPES.readonly],
      nickname: 'Magán',
      addAccount: true,
    })
    await assert.rejects(
      () =>
        service.completeOAuthCallback({
          code: 'stub-auth-code',
          state,
          connector,
          actorId: 'user-Y',
        }),
      /nickname_taken/,
    )
    assert.equal(created.length, 0)
    assert.equal(getGrant()?.id, existing.id)
  } finally {
    if (prevStub === undefined) delete process.env.CONNECTOR_OAUTH_STUB
    else process.env.CONNECTOR_OAUTH_STUB = prevStub
  }
}

{
  const existing = grant({
    accountLabel: null,
    tokenRef: 'tenant/tenant-A/user/user-Y/connector/conn-gmail',
    scopes: [GMAIL_SCOPES.readonly],
  })
  const { service, getGrant } = buildGrantService(existing)
  const connector = gmailConnector([GMAIL_SCOPES.readonly, GMAIL_SCOPES.send])
  const { state } = createOAuthState({
    userId: 'user-Y',
    connectorId: connector.id,
    tenantId: 'tenant-A',
    requestedScopes: [GMAIL_SCOPES.send],
  })
  await withGoogleTokenResponse(GMAIL_SCOPES.send, () =>
    service.completeOAuthCallback({
      code: 'auth-code',
      state,
      connector,
      actorId: 'user-Y',
    }),
  )
  assert.equal(getGrant()?.id, existing.id)
  assert.equal(getGrant()?.tokenRef, existing.tokenRef)
  const scopes = (getGrant()?.scopes as string[]) ?? []
  assert.ok(scopes.includes(GMAIL_SCOPES.readonly))
  assert.ok(scopes.includes(GMAIL_SCOPES.send))
}

{
  const existing = grant({
    accountLabel: 'anna@gmail.com',
    tokenRef: 'tenant/tenant-A/user/user-Y/connector/conn-gmail',
  })
  const { service, created, getGrant } = buildGrantService(existing)
  const connector = gmailConnector([GMAIL_SCOPES.readonly])
  const { state } = createOAuthState({
    userId: 'user-Y',
    connectorId: connector.id,
    tenantId: 'tenant-A',
    requestedScopes: [GMAIL_SCOPES.readonly],
    addAccount: true,
  })
  await withGoogleTokenResponse(GMAIL_SCOPES.readonly, () =>
    service.completeOAuthCallback({
      code: 'auth-code',
      state,
      connector,
      actorId: 'user-Y',
    }),
  )
  assert.equal(created.length, 1)
  assert.match(created[0]?.tokenRef ?? '', /\/account\/[0-9a-f]{16}$/)
  assert.notEqual(created[0]?.tokenRef, existing.tokenRef)
  assert.equal(getGrant()?.id, 'grant-created')
}

{
  const prevStub = process.env.CONNECTOR_OAUTH_STUB
  const prevGmailStub = process.env.GMAIL_OAUTH_STUB
  const prevSecret = process.env.CRM_OAUTH
  const prevFetch = globalThis.fetch
  delete process.env.CONNECTOR_OAUTH_STUB
  delete process.env.GMAIL_OAUTH_STUB
  process.env.CRM_OAUTH = 'crm-client-secret'
  let fetched = 0
  globalThis.fetch = (async () => {
    fetched += 1
    throw new Error('OAuth fetch must not run when egress denies the token host')
  }) as typeof fetch
  try {
    const tokenRef = 'tenant/tenant-A/user/user-Y/connector/conn-crm'
    const existing = grant({
      id: 'grant-crm',
      connectorId: 'conn-crm',
      tokenRef,
    })
    const { service, getGrant, statusUpdates } = buildGrantService(existing, async () => [])
    await createGrantTokenStore(tokenRef).save({
      accessToken: 'expired-access',
      refreshToken: 'refresh-token',
      expiresAt: new Date(Date.now() - 120_000).toISOString(),
    })
    const connector = {
      id: 'conn-crm',
      type: 'http_api',
      name: 'CRM',
      authMode: 'user_delegated',
      lifecycleState: 'active',
      scope: 'tenant',
      secretAlias: 'crm_oauth',
      version: 1,
      config: {
        provider: 'google-calendar',
        oauth: {
          authUrl: 'https://example.com/oauth/authorize',
          tokenUrl: 'https://example.com/oauth/token',
          clientId: 'crm-client',
          scopes: ['read'],
        },
      },
      tenantId: 'tenant-A',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    } as Connector
    await assert.rejects(
      () =>
        service.resolveAccessToken({
          connector,
          grantId: existing.id,
          tokenRef,
          actingUserId: 'user-Y',
          tenantId: 'tenant-A',
        }),
      /OAuth endpoint blocked by egress policy/,
    )
    assert.equal(fetched, 0)
    assert.equal(getGrant()?.status, 'active')
    assert.equal(
      statusUpdates.some((update) => update.status === 'expired'),
      false,
    )
  } finally {
    globalThis.fetch = prevFetch
    if (prevStub === undefined) delete process.env.CONNECTOR_OAUTH_STUB
    else process.env.CONNECTOR_OAUTH_STUB = prevStub
    if (prevGmailStub === undefined) delete process.env.GMAIL_OAUTH_STUB
    else process.env.GMAIL_OAUTH_STUB = prevGmailStub
    if (prevSecret === undefined) delete process.env.CRM_OAUTH
    else process.env.CRM_OAUTH = prevSecret
  }
}

console.log('✅ linked-account oauth: nickname_taken, re-consent, unique token-ref, egress does not expire grant')
}

void main()

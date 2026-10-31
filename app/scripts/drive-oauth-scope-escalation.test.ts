/**
 * Google Drive full_write eszkaláció a delegált OAuth-on át (#408).
 * Futtatás: npx tsx scripts/drive-oauth-scope-escalation.test.ts
 */
import assert from 'node:assert/strict'
import type { Connector, ConnectorGrant, ConnectorType } from '@prisma/client'
import { ConnectorGrantService } from '../src/domain/connector-grant/connector-grant-service'
import { DRIVE_SCOPES } from '../src/domain/connector-grant/google-drive-scopes'
import type { ConnectorGrantRepository } from '../src/repositories/interfaces'
import { createOAuthState } from '../src/lib/crypto/oauth-state'

let failures = 0
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}:`, error)
  }
}

const connector = {
  id: 'conn-drive',
  type: 'google_drive' as ConnectorType,
  name: 'Google Drive',
  authMode: 'user_delegated',
  lifecycleState: 'active',
  scope: 'global',
  secretAlias: 'drive-oauth-client',
  version: 1,
  tenantId: 'tenant-A',
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  config: {
    oauth: {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: 'drive-client',
      scopes: [DRIVE_SCOPES.readonly, DRIVE_SCOPES.file, DRIVE_SCOPES.full],
    },
  },
} as unknown as Connector

/** Egygrantos in-memory repó: a callback ezt olvassa és írja felül. */
function grantService(existingScopes: string[] | null) {
  let current: ConnectorGrant | null = existingScopes
    ? ({
        id: 'grant-drive',
        tenantId: 'tenant-A',
        connectorId: connector.id,
        userId: 'user-Y',
        status: 'active',
        scopes: existingScopes,
        tokenRef: 'tenant/tenant-A/user/user-Y/connector/conn-drive',
        accountLabel: 'stub-user@example.com',
        nickname: null,
      } as unknown as ConnectorGrant)
    : null
  const grants = {
    findActiveGrant: async () => current,
    findActiveGrants: async () => (current ? [current] : []),
    findByUser: async () => (current ? [current] : []),
    findById: async (id: string) => (current?.id === id ? current : null),
    create: async (data: Partial<ConnectorGrant>) => {
      current = { ...(current ?? {}), ...data, id: current?.id ?? 'grant-new', status: 'active' } as ConnectorGrant
      return current
    },
    updateStatus: async (_id: string, status: ConnectorGrant['status'], extra?: Partial<ConnectorGrant>) => {
      current = { ...current, status, ...extra } as ConnectorGrant
      return current
    },
    updateNickname: async () => current,
    revokeAllForUser: async () => 0,
  } as unknown as ConnectorGrantRepository
  return { service: new ConnectorGrantService(grants), scopes: () => (current?.scopes as string[]) ?? [] }
}

/** Valódi (nem stub) token-csere út: a Google `scope` mezőjét mi adjuk vissza. */
async function callback(existingScopes: string[] | null, requested: string[], returned: string[]) {
  const prev = {
    fetch: globalThis.fetch,
    stub: process.env.CONNECTOR_OAUTH_STUB,
    secret: process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET,
  }
  delete process.env.CONNECTOR_OAUTH_STUB
  process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = 'test-drive-secret'
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'ya29.x', refresh_token: '1//r', expires_in: 3600, scope: returned.join(' ') })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch
  try {
    const { service, scopes } = grantService(existingScopes)
    const { state } = createOAuthState({
      userId: 'user-Y',
      connectorId: connector.id,
      tenantId: 'tenant-A',
      requestedScopes: requested,
    })
    await service.completeOAuthCallback({ code: 'auth-code', state, connector, actorId: 'user-Y' })
    return scopes()
  } finally {
    globalThis.fetch = prev.fetch
    if (prev.stub === undefined) delete process.env.CONNECTOR_OAUTH_STUB
    else process.env.CONNECTOR_OAUTH_STUB = prev.stub
    if (prev.secret === undefined) delete process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET
    else process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = prev.secret
  }
}

const SELECTED = [DRIVE_SCOPES.readonly, DRIVE_SCOPES.file]

async function main() {
  console.log('Drive OAuth scope-eszkaláció\n')

  await test('callback: selected_write kérésre visszaadott teljes drive nem kerül a grantba', async () => {
    const scopes = await callback(null, SELECTED, [...SELECTED, DRIVE_SCOPES.full])
    assert.deepEqual([...scopes].sort(), [...SELECTED].sort())
  })

  await test('callback: korábbi full_write grant nem öröklődik selected_write újra-consentnél', async () => {
    const scopes = await callback([DRIVE_SCOPES.full], SELECTED, SELECTED)
    assert.equal(scopes.includes(DRIVE_SCOPES.full), false)
    assert.ok(scopes.includes(DRIVE_SCOPES.file))
  })

  await test('callback: explicit full_write kérés megtartja a teljes drive-ot', async () => {
    const scopes = await callback(null, [DRIVE_SCOPES.full], [DRIVE_SCOPES.full])
    assert.ok(scopes.includes(DRIVE_SCOPES.full))
  })

  await test('start: scope nélküli indítás nem-adminnak tiltott, ha a config teljes drive-ot kérne', async () => {
    const { service } = grantService(null)
    await assert.rejects(
      () => service.startUserAuthorization({ connector, userId: 'user-Y', tenantId: 'tenant-A', isAdmin: false }),
      /csak tenant-admin/,
    )
  })

  console.log(failures === 0 ? '\nAll drive-oauth-scope-escalation tests passed.' : `\n${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()

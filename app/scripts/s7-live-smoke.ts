/**
 * S7 live smoke — valódi Google Gmail OAuth on-behalf-of spike.
 *
 * Belépő: GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_CLIENT_SECRET + egy előzetesen
 * megszerzett refresh token (GMAIL_OAUTH_REFRESH_TOKEN), vagy egyszeri auth code
 * (GMAIL_OAUTH_AUTH_CODE) a redirect URI-ról.
 *
 * Kilépő: grant létrejön, a Broker gmail.search-öt futtat a user tokenjével,
 * a token nem kerül audit meta mezőkbe, revoke után DENY.
 *
 * Futtatás: npm run s7:live-smoke
 */
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

delete process.env.GMAIL_OAUTH_STUB

const REQUIRED = ['GMAIL_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CLIENT_SECRET'] as const

function hasLiveCredentials(): boolean {
  return REQUIRED.every((key) => Boolean(process.env[key]?.trim()))
}

function hasAuthMaterial(): boolean {
  return Boolean(
    process.env.GMAIL_OAUTH_REFRESH_TOKEN?.trim() || process.env.GMAIL_OAUTH_AUTH_CODE?.trim(),
  )
}

async function main() {
  console.log('=== S7 live smoke — Gmail OAuth on-behalf-of ===\n')

  if (!hasLiveCredentials() || !hasAuthMaterial()) {
    console.log('◌ Kihagyva — hiányzó live OAuth környezet.\n')
    console.log('Szükséges env:')
    console.log('  GMAIL_OAUTH_CLIENT_ID')
    console.log('  GMAIL_OAUTH_CLIENT_SECRET')
    console.log('  GMAIL_OAUTH_REDIRECT_URI (opcionális, default: localhost callback)')
    console.log('  GMAIL_OAUTH_REFRESH_TOKEN  VAGY  GMAIL_OAUTH_AUTH_CODE')
    console.log('\nLépések:')
    console.log('  1. Google Cloud Console → OAuth client (web) + Gmail API')
    console.log('  2. Redirect URI: http://localhost:3000/api/connectors/oauth/callback')
    console.log('  3. Böngészőben összekötés, majd refresh token export vagy auth code bemásolás')
    process.exit(0)
  }

  let failures = 0
  const fail = (message: string, detail?: string) => {
    failures++
    console.log(`  ❌ ${message}${detail ? ` — ${detail}` : ''}`)
  }
  const pass = (message: string, detail?: string) =>
    console.log(`  ✅ ${message}${detail ? ` — ${detail}` : ''}`)

  const { services } = await import('../src/domain')
  const { repositories } = await import('../src/repositories/postgres')
  const { prisma } = await import('../src/lib/db')
  const { createOAuthState } = await import('../src/lib/crypto/oauth-state')
  const { buildGrantTokenRef, createGrantTokenStore } = await import(
    '../src/domain/connector-grant/grant-token-vault'
  )
  const { GMAIL_SCOPES } = await import('../src/domain/connector-grant/gmail-scopes')

  const operator =
    (await prisma.user.findFirst({ where: { role: 'operator', status: 'active' } })) ??
    (await prisma.user.findFirst({ where: { status: 'active' } }))
  if (!operator) throw new Error('Nincs aktív user — futtasd: npm run db:seed')

  let gmailConnector = await prisma.connector.findFirst({
    where: { type: 'gmail', authMode: 'user_delegated' },
  })
  if (!gmailConnector) {
    gmailConnector = await prisma.connector.create({
      data: {
        name: 'Gmail (S7 live)',
        type: 'gmail',
        authMode: 'user_delegated',
        scope: 'global',
        config: {
          provider: 'google',
          oauth: {
            authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
            accountEmailField: 'email',
            scopes: [GMAIL_SCOPES.readonly],
            clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
            ...(process.env.GMAIL_OAUTH_REDIRECT_URI
              ? { redirectUri: process.env.GMAIL_OAUTH_REDIRECT_URI }
              : {}),
            offlineParams: { access_type: 'offline' },
            scopeTransform: 'gmailAlias',
          },
        },
        secretAlias: 'secret://gmail/oauth-client',
      },
    })
  }

  const agent =
    (await prisma.agent.findFirst({ where: { name: 'Wiki Agent' } })) ??
    (await prisma.agent.findFirst())
  if (!agent) throw new Error('Nincs agent — futtasd: npm run db:seed')

  const existingAgentConnector = await prisma.agentConnector.findUnique({
    where: { agentId_connectorId: { agentId: agent.id, connectorId: gmailConnector.id } },
  })
  if (!existingAgentConnector) {
    await prisma.agentConnector.create({
      data: { agentId: agent.id, connectorId: gmailConnector.id, accessMode: 'read' },
    })
  }

  for (const toolName of ['gmail_search', 'gmail_get_message']) {
    const existingCapability = await prisma.capability.findUnique({
      where: { agentId_toolName: { agentId: agent.id, toolName } },
    })
    if (!existingCapability) {
      await prisma.capability.create({
        data: { agentId: agent.id, toolName, allowed: true },
      })
    }
  }

  const refreshToken = process.env.GMAIL_OAUTH_REFRESH_TOKEN?.trim()
  const authCode = process.env.GMAIL_OAUTH_AUTH_CODE?.trim()
  let grantId: string | null = null

  try {
    if (refreshToken) {
      const tokenRef = buildGrantTokenRef({
        tenantId: operator.tenantId,
        userId: operator.id,
        connectorId: gmailConnector.id,
      })
      const store = createGrantTokenStore(tokenRef)
      await store.save({
        accessToken: 'pending-refresh',
        refreshToken,
        expiresAt: new Date(0).toISOString(),
        scopes: [GMAIL_SCOPES.readonly],
      })

      const existing = await repositories.connectorGrants.findActiveGrant({
        tenantId: operator.tenantId,
        connectorId: gmailConnector.id,
        userId: operator.id,
      })
      if (existing) {
        await services.connectorGrants.revokeGrant({
          grantId: existing.id,
          actorId: operator.id,
          actorType: 'human',
          expectedUserId: operator.id,
          expectedTenantId: operator.tenantId,
        })
      }

      const grant = await repositories.connectorGrants.create({
        tenantId: operator.tenantId,
        connectorId: gmailConnector.id,
        userId: operator.id,
        scopes: [GMAIL_SCOPES.readonly],
        tokenRef,
        accountLabel: process.env.GMAIL_OAUTH_ACCOUNT_EMAIL ?? null,
        expiresAt: null,
      })
      grantId = grant.id
      pass('Grant létrehozva refresh tokenből', grant.id.slice(0, 8))
    } else if (authCode) {
      const { state } = createOAuthState({
        userId: operator.id,
        connectorId: gmailConnector.id,
        tenantId: operator.tenantId,
        requestedScopes: [GMAIL_SCOPES.readonly],
      })
      const grant = await services.connectorGrants.completeOAuthCallback({
        code: authCode,
        state,
        connector: gmailConnector,
        actorId: operator.id,
      })
      grantId = grant.id
      pass('OAuth callback lefutott auth code-dal', grant.accountLabel ?? grant.id.slice(0, 8))
    }

    const ticket = await repositories.tickets.create({
      type: 'interaction',
      title: 'S7 live smoke',
      state: 'ready',
      assigneeType: 'agent',
      assigneeId: agent.id,
      agentId: agent.id,
      payload: {
        runAsUserId: operator.id,
        runAsAuthorizedAt: new Date().toISOString(),
        runAsAuthorizedBy: operator.id,
      },
      sourceDocumentId: null,
      createdById: operator.id,
      executeAfter: null,
      dueBy: null,
      source: 'test',
    })

    const search = await services.toolBroker.invoke({
      agentId: agent.id,
      agentVersion: agent.currentVersion,
      tool: 'gmail_search',
      args: { query: 'in:inbox', maxResults: 3 },
      ticketId: ticket.id,
    })

    if (!search.denied && search.result && typeof search.result === 'object' && 'messages' in search.result) {
      const count = Array.isArray((search.result as { messages?: unknown[] }).messages)
        ? (search.result as { messages: unknown[] }).messages.length
        : 0
      pass('Broker gmail.search live tokennel', `${count} üzenet`)
    } else {
      fail('Broker gmail.search', JSON.stringify(search))
    }

    const recentAudit = await prisma.auditLog.findMany({
      where: {
        action: { in: ['tool.call', 'connector.grant.refresh'] },
        createdAt: { gte: new Date(Date.now() - 60_000) },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })
    const leaked = recentAudit.some((row) => {
      const blob = JSON.stringify(row)
      return (
        blob.includes('refresh_token') ||
        blob.includes('access_token') ||
        blob.includes('Bearer ') ||
        (refreshToken ? blob.includes(refreshToken) : false)
      )
    })
    if (!leaked) {
      pass('Token nem szivárog auditba')
    } else {
      fail('Token leak auditban')
    }

    if (grantId) {
      await services.connectorGrants.revokeGrant({
        grantId,
        actorId: operator.id,
        actorType: 'human',
        expectedUserId: operator.id,
        expectedTenantId: operator.tenantId,
      })
      pass('Grant revoke')

      const denied = await services.toolBroker.invoke({
        agentId: agent.id,
        agentVersion: agent.currentVersion,
        tool: 'gmail_search',
        args: { query: 'in:inbox' },
        ticketId: ticket.id,
      })
      if (denied.denied && denied.reason === 'connector_grant_missing') {
        pass('Revoke után DENY')
      } else {
        fail('Revoke után deny', JSON.stringify(denied))
      }
    }

    await prisma.ticket.delete({ where: { id: ticket.id } })
  } finally {
  }

  console.log(`\n=== Összesítés: ${failures === 0 ? 'zöld' : `${failures} hiba`} ===`)
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('S7 live smoke fatal:', error instanceof Error ? error.message : error)
  process.exit(1)
})

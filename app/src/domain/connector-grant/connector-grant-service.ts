import type { Connector, Prisma } from '@prisma/client'
import type { AuditRepository, ConnectorGrantRepository } from '@/repositories/interfaces'
import {
  buildGrantTokenRef,
  createGrantTokenStore,
  isAccessTokenExpired,
  type ConnectorGrantTokens,
} from './grant-token-vault'
import { createOAuthState, pkceChallenge, verifyOAuthState } from '@/lib/crypto/oauth-state'

export type ConnectorOAuthConfig = {
  provider?: string
  oauth?: {
    authUrl?: string
    tokenUrl?: string
    scopes?: string[]
    clientId?: string
    clientIdRef?: string
    redirectUri?: string
  }
}

function readOAuthConfig(connector: Connector): Required<ConnectorOAuthConfig>['oauth'] & { provider: string } {
  const config = (connector.config ?? {}) as ConnectorOAuthConfig
  const oauth = config.oauth ?? {}
  const provider = config.provider ?? connector.type
  return {
    provider,
    authUrl: oauth.authUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: oauth.tokenUrl ?? 'https://oauth2.googleapis.com/token',
    scopes: oauth.scopes ?? ['https://www.googleapis.com/auth/gmail.readonly'],
    clientId: oauth.clientId ?? process.env.GMAIL_OAUTH_CLIENT_ID ?? '',
    clientIdRef: oauth.clientIdRef,
    redirectUri:
      oauth.redirectUri ??
      process.env.GMAIL_OAUTH_REDIRECT_URI ??
      `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/connectors/oauth/callback`,
  }
}

function resolveClientSecret(connector: Connector): string {
  if (process.env.GMAIL_OAUTH_STUB === 'true') return 'stub-client-secret'
  const alias = connector.secretAlias
  if (!alias) throw new Error('connector missing client secret alias')
  const envKey = alias.replace(/^secret:\/\//, '').replace(/\//g, '_').toUpperCase()
  const fromEnv = process.env[envKey] ?? process.env.GMAIL_OAUTH_CLIENT_SECRET
  if (!fromEnv) throw new Error(`Missing OAuth client secret for ${alias}`)
  return fromEnv
}

async function exchangeCodeForTokens(params: {
  connector: Connector
  code: string
  codeVerifier: string
}): Promise<ConnectorGrantTokens> {
  if (process.env.GMAIL_OAUTH_STUB === 'true') {
    return {
      accessToken: `stub-access-${Date.now()}`,
      refreshToken: `stub-refresh-${Date.now()}`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountEmail: 'stub-user@example.com',
      scopes: readOAuthConfig(params.connector).scopes,
    }
  }

  const oauth = readOAuthConfig(params.connector)
  const clientSecret = resolveClientSecret(params.connector)
  const body = new URLSearchParams({
    code: params.code,
    client_id: oauth.clientId!,
    client_secret: clientSecret,
    redirect_uri: oauth.redirectUri!,
    grant_type: 'authorization_code',
    code_verifier: params.codeVerifier,
  })

  const res = await fetch(oauth.tokenUrl!, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`OAuth token exchange failed: ${res.status}`)
  const data = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    scope?: string
  }

  let accountEmail: string | undefined
  if (process.env.GMAIL_OAUTH_STUB !== 'true') {
    try {
      const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { authorization: `Bearer ${data.access_token}` },
      })
      if (profileRes.ok) {
        const profile = (await profileRes.json()) as { email?: string }
        accountEmail = profile.email
      }
    } catch {
      /* optional */
    }
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? '',
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null,
    accountEmail,
    scopes: data.scope?.split(' ') ?? oauth.scopes,
  }
}

async function refreshGrantTokens(
  connector: Connector,
  current: ConnectorGrantTokens,
): Promise<ConnectorGrantTokens> {
  if (process.env.GMAIL_OAUTH_STUB === 'true') {
    return {
      ...current,
      accessToken: `stub-access-${Date.now()}`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      lastRefresh: new Date().toISOString(),
    }
  }

  const oauth = readOAuthConfig(connector)
  const clientSecret = resolveClientSecret(connector)
  const body = new URLSearchParams({
    refresh_token: current.refreshToken,
    client_id: oauth.clientId!,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  })

  const res = await fetch(oauth.tokenUrl!, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`OAuth refresh failed: ${res.status}`)
  const data = (await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? current.refreshToken,
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : current.expiresAt,
    accountEmail: current.accountEmail,
    scopes: current.scopes,
    lastRefresh: new Date().toISOString(),
  }
}

export class ConnectorGrantService {
  constructor(
    private grants: ConnectorGrantRepository,
    private audit: AuditRepository,
  ) {}

  buildAuthorizationUrl(params: {
    connector: Connector
    userId: string
    tenantId: string | null
  }): { url: string; state: string } {
    if (params.connector.authMode !== 'user_delegated') {
      throw new Error('connector is not user_delegated')
    }
    const oauth = readOAuthConfig(params.connector)
    const { state, codeVerifier } = createOAuthState({
      userId: params.userId,
      connectorId: params.connector.id,
      tenantId: params.tenantId,
    })

    const url = new URL(oauth.authUrl!)
    url.searchParams.set('client_id', oauth.clientId!)
    url.searchParams.set('redirect_uri', oauth.redirectUri!)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', oauth.scopes!.join(' '))
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', pkceChallenge(codeVerifier))
    url.searchParams.set('code_challenge_method', 'S256')

    // codeVerifier a state-ben van — callback-nál onnan jön
    return { url: url.toString(), state }
  }

  async completeOAuthCallback(params: {
    code: string
    state: string
    connector: Connector
    actorId: string
  }) {
    const statePayload = verifyOAuthState(params.state)
    if (statePayload.connectorId !== params.connector.id) {
      throw new Error('oauth_state: connector mismatch')
    }
    if (statePayload.userId !== params.actorId) {
      throw new Error('oauth_state: user mismatch')
    }

    const tokens = await exchangeCodeForTokens({
      connector: params.connector,
      code: params.code,
      codeVerifier: statePayload.codeVerifier,
    })

    const tokenRef = buildGrantTokenRef({
      tenantId: statePayload.tenantId,
      userId: statePayload.userId,
      connectorId: params.connector.id,
    })
    const store = createGrantTokenStore(tokenRef)
    await store.save(tokens)

    const grant = await this.grants.create({
      tenantId: statePayload.tenantId,
      connectorId: params.connector.id,
      userId: statePayload.userId,
      scopes: (tokens.scopes ?? []) as Prisma.JsonValue,
      tokenRef,
      accountLabel: tokens.accountEmail ?? null,
      expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'connector.grant.create',
      targetType: 'connector_grant',
      targetId: grant.id,
      modelUsed: null,
      inputRef: params.connector.id,
      outputRef: tokens.accountEmail ?? 'connected',
      policyDecision: 'allowed',
      metadata: {
        connector: params.connector.name,
        scopes: tokens.scopes ?? [],
        account_label: tokens.accountEmail ?? null,
      } as Prisma.JsonValue,
    })

    return grant
  }

  async revokeGrant(params: { grantId: string; actorId: string; actorType: 'human' | 'system' }) {
    const grant = await this.grants.findById(params.grantId)
    if (!grant) throw new Error('grant not found')

    const store = createGrantTokenStore(grant.tokenRef)
    await store.delete().catch(() => {})

    const updated = await this.grants.updateStatus(grant.id, 'revoked', { revokedAt: new Date() })

    await this.audit.append({
      actorType: params.actorType,
      actorId: params.actorId,
      agentVersion: null,
      action: 'connector.grant.revoke',
      targetType: 'connector_grant',
      targetId: grant.id,
      modelUsed: null,
      inputRef: grant.connectorId,
      outputRef: grant.userId,
      policyDecision: 'revoked',
      metadata: { actor: params.actorId } as Prisma.JsonValue,
    })

    return updated
  }

  async revokeAllForUser(userId: string, actorId: string) {
    const grants = await this.grants.findByUser(userId)
    for (const grant of grants.filter((g) => g.status === 'active')) {
      const store = createGrantTokenStore(grant.tokenRef)
      await store.delete().catch(() => {})
      await this.grants.updateStatus(grant.id, 'revoked', { revokedAt: new Date() })
      await this.audit.append({
        actorType: 'system',
        actorId,
        agentVersion: null,
        action: 'connector.grant.revoke',
        targetType: 'connector_grant',
        targetId: grant.id,
        modelUsed: null,
        inputRef: grant.connectorId,
        outputRef: userId,
        policyDecision: 'offboarding',
        metadata: { reason: 'user_suspended' } as Prisma.JsonValue,
      })
    }
  }

  async resolveAccessToken(params: {
    connector: Connector
    grantId: string
    tokenRef: string
    actingUserId: string
  }): Promise<string> {
    const store = createGrantTokenStore(params.tokenRef)
    let tokens = await store.load()

    if (isAccessTokenExpired(tokens.expiresAt)) {
      try {
        tokens = await refreshGrantTokens(params.connector, tokens)
        await store.save(tokens)
        await this.grants.updateStatus(params.grantId, 'active', {
          lastRefreshedAt: new Date(),
          expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
        })
        await this.audit.append({
          actorType: 'system',
          actorId: null,
          agentVersion: null,
          action: 'connector.grant.refresh',
          targetType: 'connector_grant',
          targetId: params.grantId,
          modelUsed: null,
          inputRef: params.connector.id,
          outputRef: params.actingUserId,
          policyDecision: 'allowed',
          metadata: { expires_at: tokens.expiresAt } as Prisma.JsonValue,
        })
      } catch {
        await this.grants.updateStatus(params.grantId, 'expired')
        await this.audit.append({
          actorType: 'system',
          actorId: null,
          agentVersion: null,
          action: 'connector.grant.expire',
          targetType: 'connector_grant',
          targetId: params.grantId,
          modelUsed: null,
          inputRef: params.connector.id,
          outputRef: params.actingUserId,
          policyDecision: 'expired',
          metadata: null,
        })
        throw new Error('grant_token_expired')
      }
    }

    return tokens.accessToken
  }

  listForUser(userId: string, tenantId?: string | null) {
    return this.grants.findByUser(userId, tenantId)
  }
}

import type { Connector, ConnectorGrant, Prisma } from '@prisma/client'
import type { AuditRepository, ConnectorGrantRepository } from '@/repositories/interfaces'
import { prisma } from '@/lib/db'
import {
  loadGoogleOAuthConfig,
  readGoogleOAuthConfigFromEnv,
  googleOAuthServiceForConnectorType,
  type GoogleOAuthConfig,
  type GoogleOAuthService,
} from '@/lib/platform-google-oauth-config'
import {
  buildGrantTokenRef,
  createGrantTokenStore,
  GrantTokenMissingError,
  isAccessTokenExpired,
  type ConnectorGrantTokens,
} from './grant-token-vault'
import { createOAuthState, pkceChallenge, verifyOAuthState } from '@/lib/crypto/oauth-state'
import {
  CONNECTOR_GRANT_NEEDED_REASONS,
  CONNECTOR_GRANT_NEEDED_VISIBILITY_MS,
  isConnectorGrantNeededReason,
  isScopeNotGrantedReason,
  type ConnectorGrantNeededCard,
  type ConnectorGrantNeededReason,
} from './connector-grant-needed'
import {
  hasDelegatedScopeCheck,
  isDelegatedOAuthStubEnabled,
  isDelegatedToolAllowedByScopes,
  parseDelegatedGrantScopes,
  scopesFromConnectorConfig,
} from './delegated-oauth-registry'
import { normalizeGmailScope } from './gmail-scopes'

export type ConnectorOAuthConfig = {
  provider?: string
  baseUrl?: string
  egressHosts?: string[]
  auth?: {
    type?: string
    authUrl?: string
    tokenUrl?: string
    clientId?: string
    scope?: string
    userInfoUrl?: string
    accountEmailField?: string
    offlineParams?: Record<string, string>
    scopeTransform?: 'none' | 'gmailAlias'
  }
  scopesSuggested?: string[]
  oauth?: {
    authUrl?: string
    tokenUrl?: string
    scopes?: string[]
    clientId?: string
    clientIdRef?: string
    redirectUri?: string
    /** Opcionális userinfo/whoami végpont a fiók-címkéhez (provider-független). */
    userInfoUrl?: string
    /** A userinfo JSON melyik mezője a fiók-címke (default: 'email'). */
    accountEmailField?: string
    offlineParams?: Record<string, string>
    scopeTransform?: 'none' | 'gmailAlias'
  }
}

function scopeNormalizerFor(connector: Connector): (scope: string) => string {
  const config = (connector.config ?? {}) as ConnectorOAuthConfig
  const transform = config.oauth?.scopeTransform ?? config.auth?.scopeTransform
  if (transform === 'gmailAlias') return normalizeGmailScope
  return (scope: string) => scope.trim()
}

type ResolvedOAuthConfig = {
  provider: string
  authUrl: string
  tokenUrl: string
  scopes: string[]
  clientId: string
  clientIdRef?: string
  redirectUri: string
  userInfoUrl?: string
  accountEmailField: string
  offlineParams: Record<string, string>
}

async function oauthErrorDetail(res: Response): Promise<string> {
  const fallback = `HTTP ${res.status}`
  try {
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const body = (await res.json()) as { error?: unknown; error_description?: unknown }
      const error = typeof body.error === 'string' ? body.error : null
      const description = typeof body.error_description === 'string' ? body.error_description : null
      return [fallback, error, description].filter(Boolean).join(' · ')
    }
    const text = (await res.text()).trim()
    return text ? `${fallback} · ${text.slice(0, 300)}` : fallback
  } catch {
    return fallback
  }
}

function readOAuthConfig(connector: Connector): ResolvedOAuthConfig {
  const config = (connector.config ?? {}) as ConnectorOAuthConfig
  const oauth = config.oauth ?? {}
  const auth = config.auth ?? {}
  const provider = config.provider ?? connector.type
  const normalize = scopeNormalizerFor(connector)

  const authUrl = oauth.authUrl ?? auth.authUrl
  const tokenUrl = oauth.tokenUrl ?? auth.tokenUrl
  if (!authUrl) throw new Error('connector oauth config missing authUrl')
  if (!tokenUrl) throw new Error('connector oauth config missing tokenUrl')

  const clientId = oauth.clientId ?? auth.clientId ?? ''
  const authScopes = auth.scope?.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  const configuredScopes = oauth.scopes ?? authScopes ?? config.scopesSuggested ?? []
  const scopes = configuredScopes.length > 0 ? configuredScopes : []
  if (scopes.length === 0) {
    throw new Error('connector oauth config missing scopes')
  }

  return {
    provider,
    authUrl,
    tokenUrl,
    scopes: scopes.map(normalize),
    clientId,
    clientIdRef: oauth.clientIdRef,
    redirectUri:
      oauth.redirectUri ??
      (() => {
        const service = googleOAuthService(connector)
        const envRedirect =
          service === 'drive'
            ? process.env.GOOGLE_DRIVE_OAUTH_REDIRECT_URI?.trim()
            : process.env.GMAIL_OAUTH_REDIRECT_URI?.trim()
        return (
          envRedirect ||
          `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/connectors/oauth/callback`
        )
      })(),
    userInfoUrl: oauth.userInfoUrl ?? auth.userInfoUrl,
    accountEmailField: oauth.accountEmailField ?? auth.accountEmailField ?? 'email',
    offlineParams: oauth.offlineParams ?? auth.offlineParams ?? {},
  }
}

function isGoogleConnector(connector: Connector): boolean {
  if (connector.type === 'gmail' || connector.type === 'google_drive') return true
  const config = (connector.config ?? {}) as ConnectorOAuthConfig
  const provider = (config.provider ?? '').toLowerCase()
  return provider.includes('google')
}

function googleOAuthService(connector: Connector): GoogleOAuthService {
  return googleOAuthServiceForConnectorType(connector.type) ?? 'gmail'
}

async function resolvePlatformGoogleOAuthConfig(
  connector: Connector,
): Promise<GoogleOAuthConfig | null> {
  if (!isGoogleConnector(connector)) return null
  const service = googleOAuthService(connector)
  try {
    const resolved = await loadGoogleOAuthConfig({
      service,
      includeEnv: true,
      listTenantSettings: async () => [],
    })
    return resolved?.config ?? null
  } catch {
    return readGoogleOAuthConfigFromEnv(service)
  }
}

async function resolveOAuthConfig(connector: Connector): Promise<ResolvedOAuthConfig> {
  const base = readOAuthConfig(connector)
  // A connector saját clientId-je nyer — a GMAIL_OAUTH_* ne írja felül pl. egy
  // Search Console connector saját Google-appját.
  if (base.clientId) return base
  const platformGoogle = await resolvePlatformGoogleOAuthConfig(connector)
  const clientId = platformGoogle?.clientId ?? ''
  if (!clientId) throw new Error('connector oauth config missing clientId')
  return {
    ...base,
    clientId,
    ...(platformGoogle?.redirectUri ? { redirectUri: platformGoogle.redirectUri } : {}),
  }
}

function resolveRequestedScopes(connector: Connector, requestedScopes?: string[]): string[] {
  const normalize = scopeNormalizerFor(connector)
  const oauth = readOAuthConfig(connector)
  const configuredScopes = oauth.scopes.map(normalize)
  const requested = requestedScopes?.map(normalize)
  if (!requested || requested.length === 0) return configuredScopes

  const configured = new Set(configuredScopes)
  const unsupported = requested.filter((scope) => !configured.has(scope))
  if (unsupported.length > 0) {
    throw new Error(`OAuth scope not configured for connector: ${unsupported.join(', ')}`)
  }
  return [...new Set(requested)]
}

function resolveGrantedScopes(params: {
  connector: Connector
  requestedScopes?: string[]
  responseScope?: string
}): string[] {
  const expectedScopes = resolveRequestedScopes(params.connector, params.requestedScopes)
  if (!params.responseScope) return expectedScopes

  const normalize = scopeNormalizerFor(params.connector)
  const grantedScopes = [...new Set(params.responseScope.split(' ').map(normalize).filter(Boolean))]
  // A connector config a felső korlát: a grant csak ebből tárol. Google a token
  // `scope` mezőjébe belerakja az identity scope-okat (openid / userinfo.*) és
  // — include_granted_scopes=true mellett — korábbi, más Google-szolgáltatásra
  // adott jogosultságokat is (pl. Drive a Gmail callbackben). Ezeket eldobjuk,
  // nem buktatjuk a callbacket; a mögöttes token ettől még szélesebb lehet.
  const configured = new Set(readOAuthConfig(params.connector).scopes.map(normalize))
  const usable = grantedScopes.filter((scope) => configured.has(scope))
  if (usable.length === 0) {
    throw new Error(`OAuth provider returned unrequested scope: ${grantedScopes.join(', ')}`)
  }
  return usable
}

async function resolveClientSecret(connector: Connector): Promise<string> {
  if (isDelegatedOAuthStubEnabled()) return 'stub-client-secret'
  const base = readOAuthConfig(connector)
  if (!base.clientId) {
    const platformGoogle = await resolvePlatformGoogleOAuthConfig(connector)
    if (platformGoogle?.clientSecret) return platformGoogle.clientSecret
  }
  const alias = connector.secretAlias
  if (!alias) throw new Error('connector missing client secret alias')

  // A generikus (nem-Google) delegált connectoroknál a client_secret a connector
  // secret-store-ja mögött áll (buildConnectorSecretRef / saveConnectorApiKey),
  // nem env-változóban. A Google/Gmail út marad az env-alapú felbontáson.
  const { isConnectorSecretRef } = await import('@/domain/connector/connector-secret-store')
  if (isConnectorSecretRef(alias)) {
    const { resolveConnectorApiKey } = await import('@/domain/connector/http-api-client')
    return resolveConnectorApiKey(alias)
  }

  const envKey = alias.replace(/^secret:\/\//, '').replace(/\//g, '_').toUpperCase()
  const service = googleOAuthService(connector)
  const fromEnv =
    process.env[envKey] ??
    (service === 'drive'
      ? process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET
      : process.env.GMAIL_OAUTH_CLIENT_SECRET)
  if (!fromEnv) throw new Error(`Missing OAuth client secret for ${alias}`)
  return fromEnv
}

async function exchangeCodeForTokens(params: {
  connector: Connector
  code: string
  codeVerifier: string
  requestedScopes?: string[]
}): Promise<ConnectorGrantTokens> {
  const oauth = await resolveOAuthConfig(params.connector)
  const fallbackScopes = resolveRequestedScopes(params.connector, params.requestedScopes)

  if (isDelegatedOAuthStubEnabled()) {
    return {
      accessToken: `stub-access-${Date.now()}`,
      refreshToken: `stub-refresh-${Date.now()}`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountEmail: 'stub-user@example.com',
      scopes: fallbackScopes,
    }
  }

  const clientSecret = await resolveClientSecret(params.connector)
  const body = new URLSearchParams({
    code: params.code,
    client_id: oauth.clientId,
    client_secret: clientSecret,
    redirect_uri: oauth.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: params.codeVerifier,
  })

  const res = await fetch(oauth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`OAuth token exchange failed: ${await oauthErrorDetail(res)}`)
  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
  }
  if (!data.access_token) throw new Error('OAuth token exchange missing access_token')
  // A grant-vault (és az aszinkron agent-hozzáférés) refresh_tokent igényel; ha a
  // provider nem adott, a hozzájárulás offline hozzáférés nélkül készült.
  if (!data.refresh_token) {
    throw new Error(
      'OAuth token exchange missing refresh_token — engedélyezd az offline hozzáférést (pl. offline_access scope / consent prompt) a providernél',
    )
  }

  // Fiók-címke: opcionális userinfo/whoami végpontról (provider-független); ha
  // nincs konfigurálva vagy hibázik, a címke egyszerűen üres marad.
  let accountEmail: string | undefined
  if (oauth.userInfoUrl) {
    try {
      const profileRes = await fetch(oauth.userInfoUrl, {
        headers: { authorization: `Bearer ${data.access_token}` },
      })
      if (profileRes.ok) {
        const profile = (await profileRes.json()) as Record<string, unknown>
        const raw = profile[oauth.accountEmailField]
        if (typeof raw === 'string' && raw.trim()) accountEmail = raw.trim()
      }
    } catch {
      /* optional */
    }
  }

  const scopes = resolveGrantedScopes({
    connector: params.connector,
    requestedScopes: params.requestedScopes,
    responseScope: data.scope,
  })

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null,
    accountEmail,
    scopes,
  }
}

async function refreshGrantTokens(
  connector: Connector,
  current: ConnectorGrantTokens,
): Promise<ConnectorGrantTokens> {
  if (isDelegatedOAuthStubEnabled()) {
    return {
      ...current,
      accessToken: `stub-access-${Date.now()}`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      lastRefresh: new Date().toISOString(),
    }
  }

  const oauth = await resolveOAuthConfig(connector)
  const clientSecret = await resolveClientSecret(connector)
  const body = new URLSearchParams({
    refresh_token: current.refreshToken,
    client_id: oauth.clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  })

  const res = await fetch(oauth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`OAuth refresh failed: ${res.status}`)
  const data = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string }
  if (!data.access_token) throw new Error('OAuth refresh missing access_token')

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

  private async loadGrantForAccess(params: {
    grantId: string
    expectedUserId?: string
    expectedTenantId?: string | null
    expectedConnectorId?: string
    expectedTokenRef?: string
    requireActive?: boolean
  }): Promise<ConnectorGrant> {
    const grant = await this.grants.findById(params.grantId)
    if (!grant) throw new Error('grant not found')
    if (params.requireActive && grant.status !== 'active') {
      throw new Error('connector_grant_not_active')
    }
    if (params.expectedUserId !== undefined && grant.userId !== params.expectedUserId) {
      throw new Error('connector_grant_forbidden')
    }
    if (params.expectedTenantId !== undefined && grant.tenantId !== params.expectedTenantId) {
      throw new Error('connector_grant_forbidden')
    }
    if (params.expectedConnectorId !== undefined && grant.connectorId !== params.expectedConnectorId) {
      throw new Error('connector_grant_forbidden')
    }
    if (params.expectedTokenRef !== undefined && grant.tokenRef !== params.expectedTokenRef) {
      throw new Error('connector_grant_forbidden')
    }
    return grant
  }

  async buildAuthorizationUrl(params: {
    connector: Connector
    userId: string
    tenantId: string | null
    requestedScopes?: string[]
    returnTo?: import('./connector-grant-needed').OAuthReturnTo
  }): Promise<{ url: string; state: string }> {
    if (params.connector.authMode !== 'user_delegated') {
      throw new Error('connector is not user_delegated')
    }
    if (params.connector.tenantId && params.connector.tenantId !== params.tenantId) {
      throw new Error('connector tenant mismatch')
    }
    const oauth = await resolveOAuthConfig(params.connector)
    const scopes = resolveRequestedScopes(params.connector, params.requestedScopes)
    const { state, codeVerifier } = createOAuthState({
      userId: params.userId,
      connectorId: params.connector.id,
      tenantId: params.tenantId,
      requestedScopes: scopes,
      ...(params.returnTo ? { returnTo: params.returnTo } : {}),
    })

    const url = new URL(oauth.authUrl)
    url.searchParams.set('client_id', oauth.clientId)
    url.searchParams.set('redirect_uri', oauth.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', scopes.join(' '))
    for (const [key, value] of Object.entries(oauth.offlineParams)) {
      url.searchParams.set(key, value)
    }
    // Google incremental auth: a korábban megadott scope-ok is a tokenben maradnak,
    // ha a consent csak a hiányzó scope-ot kéri (különben a DB unió hazudna a tokenről).
    if (isGoogleConnector(params.connector) && !url.searchParams.has('include_granted_scopes')) {
      url.searchParams.set('include_granted_scopes', 'true')
    }
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
    if (params.connector.authMode !== 'user_delegated') {
      throw new Error('connector is not user_delegated')
    }
    const statePayload = verifyOAuthState(params.state)
    if (statePayload.connectorId !== params.connector.id) {
      throw new Error('oauth_state: connector mismatch')
    }
    if (params.connector.tenantId && params.connector.tenantId !== statePayload.tenantId) {
      throw new Error('oauth_state: connector tenant mismatch')
    }
    if (statePayload.userId !== params.actorId) {
      throw new Error('oauth_state: user mismatch')
    }

    const tokens = await exchangeCodeForTokens({
      connector: params.connector,
      code: params.code,
      codeVerifier: statePayload.codeVerifier,
      requestedScopes: statePayload.requestedScopes,
    })

    // Meglévő aktív grant scope-jait uniózzuk — a least-privilege újra-consent
    // ne törölje a korábban megadott jogosultságokat a DB-ből.
    const existing = await this.grants.findActiveGrant({
      tenantId: statePayload.tenantId,
      connectorId: params.connector.id,
      userId: statePayload.userId,
    })
    const normalize = scopeNormalizerFor(params.connector)
    const mergedScopes = [
      ...new Set([
        ...parseDelegatedGrantScopes(existing?.scopes).map(normalize),
        ...(tokens.scopes ?? []).map(normalize),
      ]),
    ]
    const tokensToStore: ConnectorGrantTokens = { ...tokens, scopes: mergedScopes }

    const tokenRef = buildGrantTokenRef({
      tenantId: statePayload.tenantId,
      userId: statePayload.userId,
      connectorId: params.connector.id,
    })
    const store = createGrantTokenStore(tokenRef)
    await store.save(tokensToStore)

    const grant = await this.grants.create({
      tenantId: statePayload.tenantId,
      connectorId: params.connector.id,
      userId: statePayload.userId,
      scopes: mergedScopes as Prisma.JsonValue,
      tokenRef,
      accountLabel: tokensToStore.accountEmail ?? null,
      expiresAt: tokensToStore.expiresAt ? new Date(tokensToStore.expiresAt) : null,
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
      outputRef: tokensToStore.accountEmail ?? 'connected',
      policyDecision: 'allowed',
      metadata: {
        connector: params.connector.name,
        scopes: mergedScopes,
        account_label: tokensToStore.accountEmail ?? null,
      } as Prisma.JsonValue,
    })

    return grant
  }

  async revokeGrant(params: {
    grantId: string
    actorId: string
    actorType: 'human' | 'system'
    expectedUserId?: string
    expectedTenantId?: string | null
    reason?: string
  }) {
    const grant = await this.loadGrantForAccess({
      grantId: params.grantId,
      expectedUserId: params.expectedUserId,
      expectedTenantId: params.expectedTenantId,
    })

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
      metadata: {
        actor: params.actorId,
        ...(params.reason ? { reason: params.reason } : {}),
      } as Prisma.JsonValue,
    })

    return updated
  }

  async revokeActiveGrantsForConnector(params: {
    connectorId: string
    actorId: string
    actorType: 'human' | 'system'
    reason: string
  }): Promise<number> {
    const grants = await this.grants.findActiveByConnector(params.connectorId)
    await Promise.all(
      grants.map((grant) =>
        this.revokeGrant({
          grantId: grant.id,
          actorId: params.actorId,
          actorType: params.actorType,
          reason: params.reason,
        }),
      ),
    )
    return grants.length
  }

  async revokeGrantsForNonActiveConnectors(
    userId: string,
    tenantId: string | null | undefined,
    actorId: string,
  ): Promise<number> {
    const stale = await this.grants.findActiveForInactiveConnectors(userId, tenantId)
    await Promise.all(
      stale.map((grant) =>
        this.revokeGrant({
          grantId: grant.id,
          actorId,
          actorType: 'system',
          reason: 'connector_not_active',
        }),
      ),
    )
    return stale.length
  }

  async revokeAllForUser(userId: string, actorId: string) {
    const grants = await this.grants.findByUser(userId)
    const active = grants.filter((g) => g.status === 'active')
    await Promise.all(
      active.map(async (grant) => {
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
      }),
    )
  }

  async markGrantExpired(params: {
    grantId: string
    connectorId: string
    actingUserId: string
    tenantId?: string | null
    metadata?: Prisma.JsonValue
  }) {
    await this.loadGrantForAccess({
      grantId: params.grantId,
      expectedUserId: params.actingUserId,
      expectedTenantId: params.tenantId,
      expectedConnectorId: params.connectorId,
    })
    await this.grants.updateStatus(params.grantId, 'expired')
    await this.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'connector.grant.expire',
      targetType: 'connector_grant',
      targetId: params.grantId,
      modelUsed: null,
      inputRef: params.connectorId,
      outputRef: params.actingUserId,
      policyDecision: 'expired',
      metadata: params.metadata ?? null,
    })
  }

  async resolveAccessToken(params: {
    connector: Connector
    grantId: string
    tokenRef: string
    actingUserId: string
    tenantId: string | null
  }): Promise<string> {
    await this.loadGrantForAccess({
      grantId: params.grantId,
      expectedUserId: params.actingUserId,
      expectedTenantId: params.tenantId,
      expectedConnectorId: params.connector.id,
      expectedTokenRef: params.tokenRef,
      requireActive: true,
    })
    const store = createGrantTokenStore(params.tokenRef)
    let tokens: ConnectorGrantTokens
    try {
      tokens = await store.load()
    } catch (error) {
      // A grant DB-sora túlélheti a token-tárolót (pl. a régi efemer konténer-FS-en
      // született token, miközben a store már Secret Manager). Ilyenkor a grant
      // `active` maradna örökre, és minden tool-hívás nyers store-hibán bukna.
      // Múló store-hibán (5xx, hálózat, IAM) viszont NEM égetjük el a grantot.
      if (!(error instanceof GrantTokenMissingError)) throw error
      await this.markGrantExpired({
        grantId: params.grantId,
        connectorId: params.connector.id,
        actingUserId: params.actingUserId,
        tenantId: params.tenantId,
        metadata: { reason: 'token_unavailable', store: store.label } as Prisma.JsonValue,
      })
      throw new Error('grant_token_expired')
    }

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
        await this.markGrantExpired({
          grantId: params.grantId,
          connectorId: params.connector.id,
          actingUserId: params.actingUserId,
          tenantId: params.tenantId,
          metadata: { reason: 'refresh_failed' } as Prisma.JsonValue,
        })
        throw new Error('grant_token_expired')
      }
    }

    return tokens.accessToken
  }

  listForUser(userId: string, tenantId?: string | null) {
    return this.grants.findByUser(userId, tenantId)
  }

  /**
   * Chat/ticket újratöltés: a közelmúltbeli grant-hiányos tool-hívásokból
   * kártyát ad, ha a user grantje MÉG mindig hiányzik / kevés a scope.
   */
  async listOpenGrantNeeds(params: {
    userId: string
    tenantId: string | null
    conversationId?: string
    ticketId?: string
    payloadCards?: ConnectorGrantNeededCard[]
  }): Promise<ConnectorGrantNeededCard[]> {
    const since = new Date(Date.now() - CONNECTOR_GRANT_NEEDED_VISIBILITY_MS)
    const calls = await prisma.toolCall.findMany({
      where: {
        status: 'denied',
        createdAt: { gte: since },
        policyDecision: { in: [...CONNECTOR_GRANT_NEEDED_REASONS] },
        ...(params.conversationId ? { conversationId: params.conversationId } : {}),
        ...(params.ticketId ? { ticketId: params.ticketId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        connectorId: true,
        toolName: true,
        policyDecision: true,
      },
    })

    const fromCalls: Array<{
      connectorId: string
      toolName: string
      reason: ConnectorGrantNeededReason
    }> = []
    for (const call of calls) {
      if (!call.connectorId || !isConnectorGrantNeededReason(call.policyDecision)) continue
      fromCalls.push({
        connectorId: call.connectorId,
        toolName: call.toolName,
        reason: call.policyDecision,
      })
    }
    const fromPayload = (params.payloadCards ?? []).filter(
      (card) => card.connectorId && isConnectorGrantNeededReason(card.reason),
    )
    const seeds = [
      ...fromPayload.map((card) => ({
        connectorId: card.connectorId,
        toolName: card.toolName,
        reason: card.reason,
      })),
      ...fromCalls,
    ]

    const seen = new Set<string>()
    const unique: typeof seeds = []
    for (const seed of seeds) {
      const key = `${seed.connectorId}:${seed.reason}`
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(seed)
    }
    if (unique.length === 0) return []

    const connectors = await prisma.connector.findMany({
      where: { id: { in: unique.map((row) => row.connectorId) } },
    })
    const byId = new Map(connectors.map((connector) => [connector.id, connector]))
    const cards: ConnectorGrantNeededCard[] = []
    for (const seed of unique) {
      const connector = byId.get(seed.connectorId)
      if (!connector || connector.lifecycleState !== 'active') continue
      if (connector.authMode !== 'user_delegated') continue
      const grant = await this.grants.findActiveGrant({
        tenantId: connector.tenantId ?? params.tenantId,
        connectorId: connector.id,
        userId: params.userId,
      })
      const stillMissing = !grant
      // Scope-szűkösség: csak akkor tartjuk nyitva a kártyát, ha a providernek
      // van scope-értelmezése. Ismeretlen providernél a grant létezése a jel —
      // különben a kártya sosem tűnne el.
      const stillNarrow =
        Boolean(grant) &&
        isScopeNotGrantedReason(seed.reason) &&
        hasDelegatedScopeCheck(connector.type) &&
        !isDelegatedToolAllowedByScopes({
          connectorType: connector.type,
          toolName: seed.toolName,
          scopes: parseDelegatedGrantScopes(grant?.scopes),
        })
      if (!stillMissing && !stillNarrow) continue
      cards.push({
        connectorId: connector.id,
        connectorType: connector.type,
        connectorName: connector.name,
        toolName: seed.toolName,
        reason: seed.reason,
        scopes: scopesFromConnectorConfig(connector.config, connector.type),
      })
    }
    return cards
  }
}

import type { Connector, ConnectorGrant, Prisma } from '@prisma/client'
import type { ConnectorGrantRepository } from '@/repositories/interfaces'
import { prisma } from '@/lib/db'
import {
  loadGoogleOAuthConfig,
  readGoogleOAuthConfigFromEnv,
  googleOAuthServiceForConnector,
  googleOAuthClientSecretFromEnv,
  googleOAuthRedirectUriFromEnv,
  type GoogleOAuthConfig,
  type GoogleOAuthService,
} from '@/lib/platform-google-oauth-config'
import {
  uniqueAccountKey,
  buildGrantTokenRef,
  createGrantTokenStore,
  GrantTokenMissingError,
  isAccessTokenExpired,
  type ConnectorGrantTokens,
} from './grant-token-vault'
import {
  isGoogleLinkedAccountConnector,
  nicknameTakenByPeer,
  normalizeNickname,
} from './linked-account'
import { createOAuthState, pkceChallenge, verifyOAuthState } from '@/lib/crypto/oauth-state'
import {
  CONNECTOR_GRANT_NEEDED_REASONS,
  CONNECTOR_GRANT_NEEDED_VISIBILITY_MS,
  isConnectorGrantNeededReason,
  isScopeNotGrantedReason,
  oauthReturnPath,
  type ConnectorGrantNeededCard,
  type ConnectorGrantNeededReason,
} from './connector-grant-needed'
import {
  hasDelegatedScopeCheck,
  isDelegatedOAuthStubEnabled,
  isDelegatedToolAllowedByScopes,
  parseDelegatedGrantScopes,
  resolveGrantOAuthScopes,
  scopesFromConnectorConfig,
} from './delegated-oauth-registry'
import { driveScopeProfileRequiresAdmin } from './google-drive-scopes'
import { normalizeGmailScope } from './gmail-scopes'
import { isPlatformGoogleApiConnectorTemplateKey } from '@/lib/platform-google-api-connectors'
import { provenanceTemplateKey } from '@/lib/connector-template-icon-map'
import { tenantMailboxOf, tenantMailboxScopes } from './tenant-mailbox'
import { lookup } from 'node:dns/promises'
import { allowlistForOAuthEndpoint, guardEgressUrl } from '@/domain/net/egress-guard'

class OAuthEgressBlockedError extends Error {
  constructor(message = 'OAuth endpoint blocked by egress policy') {
    super(message)
    this.name = 'OAuthEgressBlockedError'
  }
}

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
    /** RFC 8707 resource indicator — MCP-connectoron a szerver kanonikus címe (#395 D5). */
    resource?: string
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
  resource?: string
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
  // MCP-szerver scope nélkül is adhat tokent (#395): ott az üres lista érvényes.
  if (scopes.length === 0 && connector.type !== 'mcp') {
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
        const envRedirect = googleOAuthRedirectUriFromEnv(service)
        return (
          envRedirect ||
          `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/connectors/oauth/callback`
        )
      })(),
    userInfoUrl: oauth.userInfoUrl ?? auth.userInfoUrl,
    accountEmailField: oauth.accountEmailField ?? auth.accountEmailField ?? 'email',
    offlineParams: oauth.offlineParams ?? auth.offlineParams ?? {},
    ...(oauth.resource ? { resource: oauth.resource } : {}),
  }
}

function isGoogleConnector(connector: Connector): boolean {
  return isGoogleLinkedAccountConnector({
    type: connector.type,
    config: connector.config,
  })
}

function googleOAuthService(connector: Connector): GoogleOAuthService {
  const config = (connector.config ?? {}) as ConnectorOAuthConfig
  return googleOAuthServiceForConnector({
    connectorType: connector.type,
    provider: config.provider,
  })
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
  // ugyanazon OAuth kliens korábbi, más szolgáltatásra adott jogosultságait is.
  // Ezeket eldobjuk; a kért connector-scope hiánya hibát dob.
  const configured = new Set(readOAuthConfig(params.connector).scopes.map(normalize))
  const usable = grantedScopes.filter((scope) => configured.has(scope))
  if (usable.length === 0) {
    if (expectedScopes.length > 0) {
      throw new Error(
        `connector_oauth_scopes_not_granted: requested ${expectedScopes.join(', ')}; provider returned ${grantedScopes.join(', ')}`,
      )
    }
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
  // MCP: publikus PKCE-kliens titok nélkül (a felderített szerverek többsége ilyen).
  if (!alias && connector.type === 'mcp') return ''
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
  const fromEnv = process.env[envKey] ?? googleOAuthClientSecretFromEnv(service)
  if (!fromEnv) throw new Error(`Missing OAuth client secret for ${alias}`)
  return fromEnv
}

type OAuthEgressPolicy = {
  connectorType: string
  tenantAllowlist: string[] | null
  pinToEndpointHost: boolean
}

function pinsOAuthToEndpointHost(connector: Connector): boolean {
  if (connector.type === 'gmail' || connector.type === 'google_drive') return true
  // MCP: a tenant-admin a connectorral az AS-t is választotta — pin a tárolt token-URL hostjára.
  if (connector.type === 'mcp') return true
  return isPlatformGoogleApiConnectorTemplateKey(provenanceTemplateKey(connector.config))
}

function oauthEgressPolicy(connector: Connector, tenantAllowlist: string[] | null): OAuthEgressPolicy {
  return {
    connectorType: connector.type,
    tenantAllowlist,
    pinToEndpointHost: pinsOAuthToEndpointHost(connector),
  }
}

async function fetchOAuthEndpoint(
  url: string,
  init: RequestInit,
  policy: OAuthEgressPolicy,
): Promise<Response> {
  const host = new URL(url).hostname.toLowerCase()
  const guard = await guardEgressUrl({
    url,
    allowlistHosts: allowlistForOAuthEndpoint({
      connectorType: policy.connectorType,
      url,
      tenantAllowlist: policy.tenantAllowlist,
      pinToEndpointHost: policy.pinToEndpointHost,
    }),
    resolveHostIps: async (name) => (await lookup(name, { all: true })).map((entry) => entry.address),
  })
  if (!guard.ok || guard.host !== host) throw new OAuthEgressBlockedError()
  const response = await fetch(guard.url, { ...init, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) {
    throw new OAuthEgressBlockedError('OAuth endpoint redirect blocked by egress policy')
  }
  return response
}

/** Token-kérés törzse; üres titok (publikus PKCE-kliens) nem kerül bele, a `resource` igen. */
function oauthTokenBody(
  fields: Record<string, string>,
  clientSecret: string,
  resource: string | undefined,
): URLSearchParams {
  const body = new URLSearchParams(fields)
  if (clientSecret) body.set('client_secret', clientSecret)
  if (resource) body.set('resource', resource)
  return body
}

async function exchangeCodeForTokens(params: {
  connector: Connector
  code: string
  codeVerifier: string
  requestedScopes?: string[]
  tenantAllowlist: string[] | null
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
  const body = oauthTokenBody(
    {
      code: params.code,
      client_id: oauth.clientId,
      redirect_uri: oauth.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: params.codeVerifier,
    },
    clientSecret,
    oauth.resource,
  )

  const oauthPolicy = oauthEgressPolicy(params.connector, params.tenantAllowlist)
  const res = await fetchOAuthEndpoint(oauth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  }, oauthPolicy)
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
      const profileRes = await fetchOAuthEndpoint(oauth.userInfoUrl, {
        headers: { authorization: `Bearer ${data.access_token}` },
      }, oauthPolicy)
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
  tenantAllowlist: string[] | null,
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
  const body = oauthTokenBody(
    {
      refresh_token: current.refreshToken,
      client_id: oauth.clientId,
      grant_type: 'refresh_token',
    },
    clientSecret,
    oauth.resource,
  )

  const res = await fetchOAuthEndpoint(oauth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  }, oauthEgressPolicy(connector, tenantAllowlist))
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

/** #1028: a tenant-postafiók tokenje elromlott — az adminnak kell újracsatlakoztatnia. */
export type TenantMailboxBrokenEvent = {
  tenantId: string
  connectorId: string
  grantId: string
  address: string | null
  reason: string
  actingUserId: string | null
}

export class TenantMailboxAccountMismatchError extends Error {
  constructor() {
    super('mailbox_account_mismatch')
    this.name = 'TenantMailboxAccountMismatchError'
  }
}

export class ConnectorGrantService {
  constructor(
    private grants: ConnectorGrantRepository,
    private readonly resolveEgressAllowlist?: (tenantId: string | null) => Promise<string[]>,
    private readonly onTenantMailboxBroken?: (event: TenantMailboxBrokenEvent) => Promise<void>,
  ) {}

  private async tenantAllowlistOrNull(connector: Connector): Promise<string[] | null> {
    if (!this.resolveEgressAllowlist) return null
    return this.resolveEgressAllowlist(connector.tenantId)
  }

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
    nickname?: string
    addAccount?: boolean
    owner?: 'tenant'
  }): Promise<{ url: string; state: string }> {
    const tenantOwned = params.owner === 'tenant'
    if (tenantOwned ? !tenantMailboxOf(params.connector) : params.connector.authMode !== 'user_delegated') {
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
      ...(params.nickname ? { nickname: params.nickname } : {}),
      ...(params.addAccount ? { addAccount: true } : {}),
      ...(tenantOwned ? { owner: 'tenant' as const } : {}),
    })

    const url = new URL(oauth.authUrl)
    url.searchParams.set('client_id', oauth.clientId)
    url.searchParams.set('redirect_uri', oauth.redirectUri)
    url.searchParams.set('response_type', 'code')
    if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '))
    if (oauth.resource) url.searchParams.set('resource', oauth.resource)
    for (const [key, value] of Object.entries(oauth.offlineParams)) {
      url.searchParams.set(key, value)
    }
    // Nem include_granted_scopes: ugyanazon Google OAuth kliensnél (pl. Gmail+Drive)
    // ez a korábbi szolgáltatás scope-jait húzná be a callbackbe. A startUserAuthorization
    // már uniózza a meglévő grant scope-jait a kérésbe — elég explicit scope param.
    // select_account: több Google-fiók közül lehessen választani.
    url.searchParams.set('prompt', 'select_account consent')
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', pkceChallenge(codeVerifier))
    url.searchParams.set('code_challenge_method', 'S256')

    // codeVerifier a state-ben van — callback-nál onnan jön
    return { url: url.toString(), state }
  }

  async startUserAuthorization(params: {
    connector: Connector
    userId: string
    tenantId: string
    isAdmin: boolean
    toolName?: string
    requestedScopes?: string[]
    returnTo?: import('./connector-grant-needed').OAuthReturnTo
    nickname?: string
    addAccount?: boolean
  }): Promise<{ url: string; stub?: true }> {
    if (params.connector.authMode !== 'user_delegated') {
      throw new Error('connector is not user_delegated')
    }
    if (params.connector.lifecycleState !== 'active') {
      throw new Error('connector_not_active')
    }
    if (params.connector.tenantId && params.connector.tenantId !== params.tenantId) {
      throw new Error('connector tenant mismatch')
    }

    const requestedScopes = params.toolName
      ? resolveGrantOAuthScopes({
          connectorType: params.connector.type,
          config: params.connector.config,
          toolName: params.toolName,
        })
      : params.requestedScopes

    const existingGrants = await this.grants.findActiveGrants({
      tenantId: params.connector.tenantId ?? params.tenantId,
      connectorId: params.connector.id,
      userId: params.userId,
    })
    const existingGrant = params.addAccount
      ? null
      : existingGrants.length === 1
        ? existingGrants[0]
        : null
    const configured = new Set(
      resolveGrantOAuthScopes({
        connectorType: params.connector.type,
        config: params.connector.config,
      }),
    )
    const existingScopes = parseDelegatedGrantScopes(existingGrant?.scopes).filter((scope) =>
      configured.has(scope),
    )
    const mergedRequested = [...new Set([...(requestedScopes ?? []), ...existingScopes])]
    const effectiveScopes = mergedRequested.length > 0 ? mergedRequested : undefined
    const nickname = normalizeNickname(params.nickname)
    if (nickname && nicknameTakenByPeer(existingGrants, nickname, existingGrant?.id)) {
      throw new Error('nickname_taken')
    }

    if (
      params.connector.type === 'google_drive' &&
      driveScopeProfileRequiresAdmin(effectiveScopes ?? []) &&
      !params.isAdmin
    ) {
      throw new Error(
        'A „Teljes olvasás + írás" Google Drive hozzáférést csak tenant-admin kérheti. ' +
          'Válaszd az „Olvasás + írás kijelölt fájlokon" profilt, és a Kapcsolt fiókok oldalon jelöld ki a szerkeszthető fájlokat.',
      )
    }

    const successPath = params.returnTo
      ? oauthReturnPath(params.returnTo)
      : '/control-plane/account?connected=1'

    if (isDelegatedOAuthStubEnabled()) {
      const { state } = createOAuthState({
        userId: params.userId,
        connectorId: params.connector.id,
        tenantId: params.tenantId,
        requestedScopes: effectiveScopes,
        ...(params.returnTo ? { returnTo: params.returnTo } : {}),
        ...(nickname ? { nickname } : {}),
        ...(params.addAccount ? { addAccount: true } : {}),
      })
      await this.completeOAuthCallback({
        code: 'stub-auth-code',
        state,
        connector: params.connector,
        actorId: params.userId,
      })
      return { url: successPath, stub: true }
    }

    const { url } = await this.buildAuthorizationUrl({
      connector: params.connector,
      userId: params.userId,
      tenantId: params.tenantId,
      requestedScopes: effectiveScopes,
      ...(params.returnTo ? { returnTo: params.returnTo } : {}),
      ...(nickname ? { nickname } : {}),
      ...(params.addAccount ? { addAccount: true } : {}),
    })
    return { url }
  }

  async completeOAuthCallback(params: {
    code: string
    state: string
    connector: Connector
    actorId: string
  }) {
    const statePayload = verifyOAuthState(params.state)
    if (statePayload.owner === 'tenant') return this.completeTenantMailboxCallback(params)
    if (params.connector.authMode !== 'user_delegated') {
      throw new Error('connector is not user_delegated')
    }
    if (statePayload.connectorId !== params.connector.id) {
      throw new Error('oauth_state: connector mismatch')
    }
    if (params.connector.tenantId && params.connector.tenantId !== statePayload.tenantId) {
      throw new Error('oauth_state: connector tenant mismatch')
    }
    if (statePayload.userId !== params.actorId) {
      throw new Error('oauth_state: user mismatch')
    }

    let tokens = await exchangeCodeForTokens({
      connector: params.connector,
      code: params.code,
      codeVerifier: statePayload.codeVerifier,
      requestedScopes: statePayload.requestedScopes,
      tenantAllowlist: await this.tenantAllowlistOrNull(params.connector),
    })

    if (!statePayload.tenantId) throw new Error('tenant required')
    const nickname = normalizeNickname(statePayload.nickname)
    if (isDelegatedOAuthStubEnabled() && statePayload.addAccount) {
      const slug = (nickname ?? `user-${Date.now().toString(36)}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      tokens = { ...tokens, accountEmail: `stub-${slug || 'user'}@example.com` }
    }

    const peers = await this.grants.findByUser(statePayload.userId, statePayload.tenantId)
    const sameConnector = peers.filter((grant) => grant.connectorId === params.connector.id)
    const email = tokens.accountEmail?.trim().toLowerCase() ?? null
    const existing = email
      ? sameConnector.find((grant) => grant.accountLabel?.trim().toLowerCase() === email)
      : !statePayload.addAccount && sameConnector.filter((grant) => grant.status === 'active').length === 1
        ? sameConnector.find((grant) => grant.status === 'active')
        : undefined

    if (nickname && nicknameTakenByPeer(sameConnector, nickname, existing?.id)) {
      throw new Error('nickname_taken')
    }

    // Meglévő aktív grant scope-jait uniózzuk — a least-privilege újra-consent
    // ne törölje a korábban megadott jogosultságokat a DB-ből. Másik fiók
    // hozzáadásakor nem keverjük a scope-okat.
    const normalize = scopeNormalizerFor(params.connector)
    const mergedScopes = [
      ...new Set([
        ...(existing ? parseDelegatedGrantScopes(existing.scopes).map(normalize) : []),
        ...(tokens.scopes ?? []).map(normalize),
      ]),
    ]
    const tokensToStore: ConnectorGrantTokens = { ...tokens, scopes: mergedScopes }

    const tokenRef =
      existing?.tokenRef ??
      buildGrantTokenRef({
        tenantId: statePayload.tenantId,
        userId: statePayload.userId,
        connectorId: params.connector.id,
        accountKey: uniqueAccountKey(),
      })
    const store = createGrantTokenStore(tokenRef)
    await store.save(tokensToStore)

    const grant = await this.grants.create({
      tenantId: statePayload.tenantId,
      connectorId: params.connector.id,
      userId: statePayload.userId,
      scopes: mergedScopes as Prisma.JsonValue,
      tokenRef,
      accountLabel: tokensToStore.accountEmail ?? existing?.accountLabel ?? null,
      ...(nickname ? { nickname } : {}),
      expiresAt: tokensToStore.expiresAt ? new Date(tokensToStore.expiresAt) : null,
    })

    return grant
  }

  /**
   * #1028: az admin a tenant nevében köti be a postafiókot. A token a tenanté; a
   * `userId` a state-ben csak a bekötő admin (audit), a grantbe nem kerül.
   */
  async startTenantMailboxAuthorization(params: {
    connector: Connector
    userId: string
    tenantId: string
  }): Promise<{ url: string; stub?: true }> {
    const mailbox = tenantMailboxOf(params.connector)
    if (!mailbox) throw new Error('connector_not_tenant_mailbox')
    if (params.connector.lifecycleState !== 'active') throw new Error('connector_not_active')
    if (params.connector.tenantId !== params.tenantId) throw new Error('connector tenant mismatch')
    const requestedScopes = tenantMailboxScopes(mailbox.source, mailbox.readOnly)
    const returnTo = { kind: 'mailboxes' as const }

    if (isDelegatedOAuthStubEnabled()) {
      const { state } = createOAuthState({
        userId: params.userId,
        connectorId: params.connector.id,
        tenantId: params.tenantId,
        requestedScopes,
        returnTo,
        owner: 'tenant',
      })
      await this.completeTenantMailboxCallback({
        code: 'stub-auth-code',
        state,
        connector: params.connector,
        actorId: params.userId,
      })
      return { url: oauthReturnPath(returnTo), stub: true }
    }

    const { url } = await this.buildAuthorizationUrl({
      connector: params.connector,
      userId: params.userId,
      tenantId: params.tenantId,
      requestedScopes,
      returnTo,
      owner: 'tenant',
    })
    return { url }
  }

  private async completeTenantMailboxCallback(params: {
    code: string
    state: string
    connector: Connector
    actorId: string
  }): Promise<ConnectorGrant> {
    const mailbox = tenantMailboxOf(params.connector)
    if (!mailbox) throw new Error('connector_not_tenant_mailbox')
    const statePayload = verifyOAuthState(params.state)
    if (statePayload.owner !== 'tenant') throw new Error('oauth_state: owner mismatch')
    if (statePayload.connectorId !== params.connector.id) throw new Error('oauth_state: connector mismatch')
    if (!statePayload.tenantId || params.connector.tenantId !== statePayload.tenantId) {
      throw new Error('oauth_state: connector tenant mismatch')
    }
    if (statePayload.userId !== params.actorId) throw new Error('oauth_state: user mismatch')

    const tokens = await exchangeCodeForTokens({
      connector: params.connector,
      code: params.code,
      codeVerifier: statePayload.codeVerifier,
      requestedScopes: statePayload.requestedScopes,
      tenantAllowlist: await this.tenantAllowlistOrNull(params.connector),
    })
    const address = tokens.accountEmail?.trim().toLowerCase() || null
    if (!address) throw new Error('mailbox_address_unknown')
    // Újracsatlakoztatás más fiókkal csendben kicserélné, kinek a leveleit olvassák az agentek.
    if (mailbox.address && mailbox.address.toLowerCase() !== address) {
      throw new TenantMailboxAccountMismatchError()
    }

    const existing = await this.grants.findLatestTenantGrant({
      tenantId: statePayload.tenantId,
      connectorId: params.connector.id,
    })
    const tokenRef =
      existing?.tokenRef ??
      `tenant/${statePayload.tenantId}/mailbox/connector/${params.connector.id}/account/${uniqueAccountKey()}`
    await createGrantTokenStore(tokenRef).save(tokens)

    const grant = await this.grants.upsertTenantGrant({
      tenantId: statePayload.tenantId,
      connectorId: params.connector.id,
      scopes: (tokens.scopes ?? []) as Prisma.JsonValue,
      tokenRef,
      accountLabel: address,
      expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
      // Csak audit: a hozzáférést nem befolyásolja, a bekötő kilépése után is működik.
      metadata: { connectedByUserId: statePayload.userId, connectedAt: new Date().toISOString() },
    })
    if (!mailbox.address) {
      await prisma.connector.update({
        where: { id: params.connector.id },
        data: {
          name: `Postafiók · ${address}`,
          config: {
            ...((params.connector.config ?? {}) as Prisma.JsonObject),
            mailbox: { ...mailbox, address },
          },
        },
      })
    }
    return grant
  }

  async updateNickname(params: {
    grantId: string
    nickname: string | null
    actorId: string
    expectedUserId?: string
    expectedTenantId?: string | null
  }) {
    const grant = await this.loadGrantForAccess({
      grantId: params.grantId,
      expectedUserId: params.expectedUserId,
      expectedTenantId: params.expectedTenantId,
    })
    const nickname =
      params.nickname == null || params.nickname.trim() === ''
        ? null
        : normalizeNickname(params.nickname)
    if (params.nickname != null && params.nickname.trim() !== '' && !nickname) {
      throw new Error('invalid_nickname')
    }
    if (nickname && !grant.userId) throw new Error('connector_grant_forbidden')
    if (nickname && grant.userId) {
      const peers = await this.grants.findActiveGrants({
        tenantId: grant.tenantId,
        connectorId: grant.connectorId,
        userId: grant.userId,
      })
      if (nicknameTakenByPeer(peers, nickname, grant.id)) throw new Error('nickname_taken')
    }
    return this.grants.updateNickname(grant.id, nickname)
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
    const stale = await this.grants.findActiveForInactiveConnectors(userId, tenantId ?? undefined)
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
    const grant = await this.loadGrantForAccess({
      grantId: params.grantId,
      expectedTenantId: params.tenantId,
      expectedConnectorId: params.connectorId,
    })
    if (grant.ownerType !== 'tenant' && grant.userId !== params.actingUserId) {
      throw new Error('connector_grant_forbidden')
    }
    await this.grants.updateStatus(params.grantId, 'expired')
    if (grant.ownerType === 'tenant' && this.onTenantMailboxBroken) {
      const meta = (params.metadata ?? {}) as { reason?: unknown }
      await this.onTenantMailboxBroken({
        tenantId: grant.tenantId,
        connectorId: grant.connectorId,
        grantId: grant.id,
        address: grant.accountLabel,
        reason: typeof meta.reason === 'string' ? meta.reason : 'expired',
        actingUserId: params.actingUserId || null,
      }).catch(() => {})
    }
  }

  async resolveAccessToken(params: {
    connector: Connector
    grantId: string
    tokenRef: string
    actingUserId: string
    tenantId: string | null
  }): Promise<string> {
    const grant = await this.loadGrantForAccess({
      grantId: params.grantId,
      expectedTenantId: params.tenantId,
      expectedConnectorId: params.connector.id,
      expectedTokenRef: params.tokenRef,
      requireActive: true,
    })
    // User-grant csak a gazdájáé; tenant-grant csak tenant-postafiók konnektoron él,
    // a hívó jogát ott az agent-kötés (authorizeToolCall) adja.
    if (grant.ownerType === 'tenant') {
      if (!tenantMailboxOf(params.connector)) throw new Error('connector_grant_forbidden')
    } else if (grant.userId !== params.actingUserId) {
      throw new Error('connector_grant_forbidden')
    }
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
      const tenantAllowlist = await this.tenantAllowlistOrNull(params.connector)
      try {
        tokens = await refreshGrantTokens(
          params.connector,
          tokens,
          tenantAllowlist,
        )
        await store.save(tokens)
        await this.grants.updateStatus(params.grantId, 'active', {
          lastRefreshedAt: new Date(),
          expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
        })

      } catch (error) {
        if (error instanceof OAuthEgressBlockedError) throw error
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
    return this.grants.findByUser(userId, tenantId ?? undefined)
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
    const calls: Array<{
      connectorId?: string | null
      toolName?: string | null
      policyDecision?: string | null
    }> = []
    void since
    void prisma

    const fromCalls: Array<{
      connectorId: string
      toolName: string
      reason: ConnectorGrantNeededReason
    }> = []
    for (const call of calls) {
      if (!call.connectorId || !isConnectorGrantNeededReason(call.policyDecision)) continue
      if (!call.toolName) continue
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

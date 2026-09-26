import { isRecord, parseHttpApiConfig } from './http-api-client'

export type ConnectorConfigBackfillContext = {
  connectorType?: string
  connectorName?: string
}

export type ConnectorConfigBackfillResult = {
  config: Record<string, unknown>
  changed: boolean
  addedGoogleOauthDefaults: boolean
}

const GOOGLE_OAUTH_DEFAULTS = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  accountEmailField: 'email',
  offlineParams: { access_type: 'offline' },
  scopeTransform: 'gmailAlias' as const,
}

export function backfillHttpApiConnectorConfig(
  input: unknown,
  context: ConnectorConfigBackfillContext = {},
): ConnectorConfigBackfillResult {
  if (!isRecord(input)) throw new Error('connector config must be an object')
  const raw = structuredClone(input) as Record<string, unknown>
  const authRaw = isRecord(raw.auth) ? raw.auth : null
  if (!authRaw && context.connectorType === 'gmail' && isRecord(raw.oauth)) {
    const oauth = { ...raw.oauth }
    let addedGoogleOauthDefaults = false
    for (const [key, value] of Object.entries(GOOGLE_OAUTH_DEFAULTS)) {
      if (oauth[key] === undefined || oauth[key] === '') {
        oauth[key] = value
        addedGoogleOauthDefaults = true
      }
    }
    const next = pruneUndefined({ ...raw, provider: raw.provider ?? 'google', oauth }) as Record<string, unknown>
    return {
      config: next,
      changed: stableStringify(pruneUndefined(raw)) !== stableStringify(next),
      addedGoogleOauthDefaults,
    }
  }
  if (!authRaw) throw new Error('connector config.auth is required')

  const googleLegacy = isLegacyGoogleConnector(raw, context)
  let addedGoogleOauthDefaults = false
  const auth = canonicalAuth(authRaw, googleLegacy)
  if (auth.addedGoogleOauthDefaults) addedGoogleOauthDefaults = true

  const next: Record<string, unknown> = {
    ...raw,
    auth: auth.value,
  }

  if (Array.isArray(raw.endpoints)) {
    next.endpoints = raw.endpoints.map(canonicalEndpoint).filter(Boolean)
  } else if (Array.isArray(raw.proposedTools)) {
    next.endpoints = raw.proposedTools.map(canonicalEndpoint).filter(Boolean)
    delete next.proposedTools
  }

  const parsed = parseHttpApiConfig(next)
  next.baseUrl = parsed.baseUrl
  next.auth = parsed.auth
  if (parsed.endpoints) next.endpoints = parsed.endpoints.map(canonicalEndpoint).filter(Boolean)

  const stableNext = pruneUndefined(next) as Record<string, unknown>
  return {
    config: stableNext,
    changed: stableStringify(pruneUndefined(raw)) !== stableStringify(stableNext),
    addedGoogleOauthDefaults,
  }
}

function canonicalAuth(
  authRaw: Record<string, unknown>,
  googleLegacy: boolean,
): { value: Record<string, unknown>; addedGoogleOauthDefaults: boolean } {
  let addedGoogleOauthDefaults = false

  if (authRaw.scheme === 'header') {
    return { value: { scheme: 'header', header: authRaw.header }, addedGoogleOauthDefaults }
  }
  if (authRaw.scheme === 'bearer') return { value: { scheme: 'bearer' }, addedGoogleOauthDefaults }
  if (authRaw.scheme === 'basic' || authRaw.type === 'basic') {
    return { value: { scheme: 'basic', username: authRaw.username }, addedGoogleOauthDefaults }
  }
  if (authRaw.type === 'api_key_header') {
    return {
      value: { scheme: 'header', header: authRaw.headerName },
      addedGoogleOauthDefaults,
    }
  }
  if (authRaw.type === 'bearer_token') {
    return { value: { scheme: 'bearer' }, addedGoogleOauthDefaults }
  }

  if (authRaw.scheme === 'oauth2' || authRaw.type === 'oauth2') {
    const oauth: Record<string, unknown> = { ...authRaw, scheme: 'oauth2' }
    delete oauth.type
    if (googleLegacy) {
      for (const [key, value] of Object.entries(GOOGLE_OAUTH_DEFAULTS)) {
        if (oauth[key] === undefined || oauth[key] === '') {
          oauth[key] = value
          addedGoogleOauthDefaults = true
        }
      }
    }
    return { value: oauth, addedGoogleOauthDefaults }
  }

  return { value: { ...authRaw }, addedGoogleOauthDefaults }
}

function canonicalEndpoint(endpoint: unknown): Record<string, unknown> | null {
  if (!isRecord(endpoint)) return null
  const method = typeof endpoint.method === 'string' ? endpoint.method.toUpperCase() : ''
  const path = typeof endpoint.path === 'string' ? endpoint.path : ''
  if (!method || !path) return null
  return {
    method,
    path,
    ...(typeof endpoint.description === 'string' ? { description: endpoint.description } : {}),
    ...(typeof endpoint.profile === 'string' ? { profile: endpoint.profile } : {}),
    ...(endpoint.idempotent === true ? { idempotent: true } : {}),
    ...(isRecord(endpoint.headers) ? { headers: endpoint.headers } : {}),
  }
}

function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneUndefined)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = pruneUndefined(item)
  }
  return out
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
  return out
}

function isLegacyGoogleConnector(
  config: Record<string, unknown>,
  context: ConnectorConfigBackfillContext,
): boolean {
  if (context.connectorType === 'gmail') return true
  const candidates = [
    context.connectorName,
    typeof config.provider === 'string' ? config.provider : undefined,
    typeof config.baseUrl === 'string' ? config.baseUrl : undefined,
  ]
  return candidates.some((value) => {
    const normalized = value?.toLowerCase() ?? ''
    return (
      normalized.includes('gmail') ||
      normalized.includes('google-workspace') ||
      normalized.includes('googleapis.com')
    )
  })
}

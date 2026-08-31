import type { Prisma } from '@prisma/client'

export type GoogleOAuthService = 'gmail' | 'drive'

/** Történeti kulcs — Gmail platform OAuth (backward compat). */
export const GOOGLE_OAUTH_PLATFORM_KEY = 'oauth.google'

export const GOOGLE_OAUTH_SERVICE_KEYS: Record<GoogleOAuthService, string> = {
  gmail: 'oauth.google.gmail',
  drive: 'oauth.google.drive',
}

export type GoogleOAuthConfig = {
  clientId: string
  clientSecret: string
  redirectUri?: string
}

export type GoogleDrivePickerConfig = {
  apiKey: string
  appId: string
}

export type GoogleOAuthSource = 'platform' | 'env' | 'tenant_legacy'

export type GoogleOAuthResolved = {
  config: GoogleOAuthConfig
  source: GoogleOAuthSource
}

export function parseGoogleOAuthFields(raw: unknown): GoogleOAuthConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  const clientId = typeof rec.clientId === 'string' ? rec.clientId.trim() : ''
  const clientSecret = typeof rec.clientSecret === 'string' ? rec.clientSecret.trim() : ''
  const redirectUri = typeof rec.redirectUri === 'string' ? rec.redirectUri.trim() : ''
  if (!clientId || !clientSecret) return null
  return {
    clientId,
    clientSecret,
    ...(redirectUri ? { redirectUri } : {}),
  }
}

export function parseGoogleDrivePickerFields(raw: unknown): GoogleDrivePickerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  const apiKey = typeof rec.apiKey === 'string' ? rec.apiKey.trim() : ''
  const appId = typeof rec.appId === 'string' ? rec.appId.trim() : ''
  if (!apiKey || !appId) return null
  return { apiKey, appId }
}

export function readTenantGoogleOAuthConfig(
  settings: Prisma.JsonValue | null | undefined,
  service: GoogleOAuthService = 'gmail',
): GoogleOAuthConfig | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null
  const oauth = (settings as { oauth?: { google?: unknown; googleGmail?: unknown; googleDrive?: unknown } }).oauth
  if (service === 'drive') {
    return parseGoogleOAuthFields((oauth as { drive?: unknown })?.drive)
  }
  return parseGoogleOAuthFields(oauth?.google)
}

export function readGoogleOAuthConfigFromEnv(service: GoogleOAuthService = 'gmail'): GoogleOAuthConfig | null {
  if (service === 'drive') {
    return parseGoogleOAuthFields({
      clientId: process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_DRIVE_OAUTH_REDIRECT_URI,
    })
  }
  return parseGoogleOAuthFields({
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.GMAIL_OAUTH_REDIRECT_URI,
  })
}

export function readGoogleDrivePickerFromEnv(): GoogleDrivePickerConfig | null {
  return parseGoogleDrivePickerFields({
    apiKey: process.env.GOOGLE_DRIVE_PICKER_API_KEY,
    appId: process.env.GOOGLE_DRIVE_PICKER_APP_ID,
  })
}

export function resolveGoogleOAuthConfig(input: {
  platformValue: unknown | null
  legacyPlatformValue?: unknown | null
  envConfig?: GoogleOAuthConfig | null
  tenantSettings?: unknown[]
  /** Harvest target — Drive must not fall back to Gmail `oauth.google`. */
  service?: GoogleOAuthService
}): GoogleOAuthResolved | null {
  const service = input.service ?? 'gmail'
  const fromPlatform = parseGoogleOAuthFields(input.platformValue)
  if (fromPlatform) return { config: fromPlatform, source: 'platform' }
  const fromLegacy = parseGoogleOAuthFields(input.legacyPlatformValue)
  if (fromLegacy) return { config: fromLegacy, source: 'platform' }
  if (input.envConfig) return { config: input.envConfig, source: 'env' }
  for (const settings of input.tenantSettings ?? []) {
    const harvested = readTenantGoogleOAuthConfig(settings as Prisma.JsonValue, service)
    if (harvested) return { config: harvested, source: 'tenant_legacy' }
  }
  return null
}

export function googleOAuthServiceForConnectorType(connectorType: string): GoogleOAuthService | null {
  if (connectorType === 'gmail') return 'gmail'
  if (connectorType === 'google_drive') return 'drive'
  return null
}

export async function loadGoogleOAuthConfig(opts?: {
  service?: GoogleOAuthService
  getPlatformValue?: () => Promise<unknown | null>
  getLegacyPlatformValue?: () => Promise<unknown | null>
  listTenantSettings?: () => Promise<unknown[]>
  includeEnv?: boolean
}): Promise<GoogleOAuthResolved | null> {
  const service = opts?.service ?? 'gmail'
  const { configPrisma, prisma } = await import('@/lib/db')
  const serviceKey = GOOGLE_OAUTH_SERVICE_KEYS[service]
  const platformValue = opts?.getPlatformValue
    ? await opts.getPlatformValue()
    : ((await configPrisma.platformSetting.findUnique({ where: { key: serviceKey } }))?.value ?? null)
  const legacyPlatformValue =
    service === 'gmail' && !parseGoogleOAuthFields(platformValue)
      ? opts?.getLegacyPlatformValue
        ? await opts.getLegacyPlatformValue()
        : ((await configPrisma.platformSetting.findUnique({ where: { key: GOOGLE_OAUTH_PLATFORM_KEY } }))
            ?.value ?? null)
      : null
  const envConfig = opts?.includeEnv === false ? null : readGoogleOAuthConfigFromEnv(service)
  const needsHarvest =
    !parseGoogleOAuthFields(platformValue) &&
    !parseGoogleOAuthFields(legacyPlatformValue) &&
    !envConfig
  const tenantSettings = needsHarvest
    ? opts?.listTenantSettings
      ? await opts.listTenantSettings()
      : (await prisma.tenant.findMany({ select: { settings: true } })).map((row) => row.settings)
    : undefined
  return resolveGoogleOAuthConfig({
    platformValue,
    legacyPlatformValue,
    envConfig,
    tenantSettings,
    service,
  })
}

export async function loadGoogleDrivePickerConfig(opts?: {
  getPlatformValue?: () => Promise<unknown | null>
  includeEnv?: boolean
}): Promise<{ config: GoogleDrivePickerConfig; source: GoogleOAuthSource } | null> {
  const { configPrisma } = await import('@/lib/db')
  const platformValue = opts?.getPlatformValue
    ? await opts.getPlatformValue()
    : ((await configPrisma.platformSetting.findUnique({ where: { key: 'oauth.google.drive.picker' } }))
        ?.value ?? null)
  const fromPlatform = parseGoogleDrivePickerFields(platformValue)
  if (fromPlatform) return { config: fromPlatform, source: 'platform' }
  if (opts?.includeEnv === false) return null
  const fromEnv = readGoogleDrivePickerFromEnv()
  if (fromEnv) return { config: fromEnv, source: 'env' }
  return null
}

export function toGoogleOAuthPublicView(resolved: GoogleOAuthResolved | null): {
  configured: boolean
  persisted: boolean
  source: GoogleOAuthSource | null
  clientId: string | null
  redirectUri: string | null
} {
  if (!resolved) {
    return {
      configured: false,
      persisted: false,
      source: null,
      clientId: null,
      redirectUri: null,
    }
  }
  return {
    configured: true,
    persisted: resolved.source === 'platform',
    source: resolved.source,
    clientId: resolved.config.clientId,
    redirectUri: resolved.config.redirectUri ?? null,
  }
}

export function toGoogleDrivePickerPublicView(
  resolved: { config: GoogleDrivePickerConfig; source: GoogleOAuthSource } | null,
): {
  configured: boolean
  persisted: boolean
  source: GoogleOAuthSource | null
  appId: string | null
} {
  if (!resolved) {
    return { configured: false, persisted: false, source: null, appId: null }
  }
  return {
    configured: true,
    persisted: resolved.source === 'platform',
    source: resolved.source,
    appId: resolved.config.appId,
  }
}

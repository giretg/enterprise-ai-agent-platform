import type { Prisma } from '@prisma/client'

export const GOOGLE_OAUTH_PLATFORM_KEY = 'oauth.google'

export type GoogleOAuthConfig = {
  clientId: string
  clientSecret: string
  redirectUri?: string
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

export function readTenantGoogleOAuthConfig(
  settings: Prisma.JsonValue | null | undefined,
): GoogleOAuthConfig | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null
  const oauth = (settings as { oauth?: { google?: unknown } }).oauth
  return parseGoogleOAuthFields(oauth?.google)
}

export function readGoogleOAuthConfigFromEnv(): GoogleOAuthConfig | null {
  return parseGoogleOAuthFields({
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.GMAIL_OAUTH_REDIRECT_URI,
  })
}

export function resolveGoogleOAuthConfig(input: {
  platformValue: unknown | null
  envConfig?: GoogleOAuthConfig | null
  tenantSettings?: unknown[]
}): GoogleOAuthResolved | null {
  const fromPlatform = parseGoogleOAuthFields(input.platformValue)
  if (fromPlatform) return { config: fromPlatform, source: 'platform' }
  if (input.envConfig) return { config: input.envConfig, source: 'env' }
  for (const settings of input.tenantSettings ?? []) {
    const harvested = readTenantGoogleOAuthConfig(settings as Prisma.JsonValue)
    if (harvested) return { config: harvested, source: 'tenant_legacy' }
  }
  return null
}

export async function loadGoogleOAuthConfig(opts?: {
  getPlatformValue?: () => Promise<unknown | null>
  listTenantSettings?: () => Promise<unknown[]>
  includeEnv?: boolean
}): Promise<GoogleOAuthResolved | null> {
  const { configPrisma, prisma } = await import('@/lib/db')
  const platformValue = opts?.getPlatformValue
    ? await opts.getPlatformValue()
    : ((await configPrisma.platformSetting.findUnique({ where: { key: GOOGLE_OAUTH_PLATFORM_KEY } }))
        ?.value ?? null)
  const envConfig = opts?.includeEnv === false ? null : readGoogleOAuthConfigFromEnv()
  const needsHarvest = !parseGoogleOAuthFields(platformValue) && !envConfig
  const tenantSettings = needsHarvest
    ? opts?.listTenantSettings
      ? await opts.listTenantSettings()
      : (await prisma.tenant.findMany({ select: { settings: true } })).map((row) => row.settings)
    : undefined
  return resolveGoogleOAuthConfig({ platformValue, envConfig, tenantSettings })
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

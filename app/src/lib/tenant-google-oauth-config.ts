import type { Prisma } from '@prisma/client'

export type TenantGoogleOAuthConfig = {
  clientId: string
  clientSecret: string
  redirectUri?: string
}

type TenantSettingsShape = {
  oauth?: {
    google?: {
      clientId?: unknown
      clientSecret?: unknown
      redirectUri?: unknown
    }
  }
}

export function readTenantGoogleOAuthConfig(
  settings: Prisma.JsonValue | null | undefined,
): TenantGoogleOAuthConfig | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null
  const shape = settings as TenantSettingsShape
  const raw = shape.oauth?.google
  if (!raw || typeof raw !== 'object') return null

  const clientId = typeof raw.clientId === 'string' ? raw.clientId.trim() : ''
  const clientSecret = typeof raw.clientSecret === 'string' ? raw.clientSecret.trim() : ''
  const redirectUri = typeof raw.redirectUri === 'string' ? raw.redirectUri.trim() : ''
  if (!clientId || !clientSecret) return null
  return {
    clientId,
    clientSecret,
    ...(redirectUri ? { redirectUri } : {}),
  }
}

export function upsertTenantGoogleOAuthConfig(
  settings: Prisma.JsonValue | null | undefined,
  input: TenantGoogleOAuthConfig,
): Prisma.InputJsonValue {
  const base =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? ({ ...(settings as Record<string, unknown>) } as Record<string, unknown>)
      : {}
  const oauth =
    base.oauth && typeof base.oauth === 'object' && !Array.isArray(base.oauth)
      ? ({ ...(base.oauth as Record<string, unknown>) } as Record<string, unknown>)
      : {}
  oauth.google = {
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    ...(input.redirectUri ? { redirectUri: input.redirectUri } : {}),
  }
  base.oauth = oauth
  return base as Prisma.InputJsonValue
}

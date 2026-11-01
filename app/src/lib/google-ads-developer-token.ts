/**
 * Google Ads API developer token — PLATFORM-szintű beállítás.
 *
 * A token az API-t hívó alkalmazást (a platform Google API OAuth appját és annak Google Cloud
 * projektjét) azonosítja, nem a hirdetőt: egy token csak egy Cloud projekttel használható.
 * Ezért a platform superadminja egyszer állítja be; a tenantok csak azt kötik be, MELYIK
 * Google Ads fiókjukat érje el a konnektor (googleAccountBinding), a felhasználók pedig a saját
 * Google-fiókjukkal lépnek be (ConnectorGrant).
 */

export const GOOGLE_ADS_DEVELOPER_TOKEN_KEY = 'google.ads.developer_token'

export type GoogleAdsDeveloperTokenSource = 'platform' | 'env'

export type GoogleAdsDeveloperTokenResolved = {
  developerToken: string
  source: GoogleAdsDeveloperTokenSource
}

export function parseGoogleAdsDeveloperToken(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const token = (raw as { developerToken?: unknown }).developerToken
  return typeof token === 'string' && token.trim() ? token.trim() : null
}

export function readGoogleAdsDeveloperTokenFromEnv(): string | null {
  const token = process.env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim()
  return token || null
}

export async function loadGoogleAdsDeveloperToken(opts?: {
  getPlatformValue?: () => Promise<unknown | null>
  includeEnv?: boolean
}): Promise<GoogleAdsDeveloperTokenResolved | null> {
  let platformValue: unknown | null
  if (opts?.getPlatformValue) {
    platformValue = await opts.getPlatformValue()
  } else {
    const { prisma } = await import('@/lib/db')
    platformValue =
      (await prisma.platformSetting.findUnique({ where: { key: GOOGLE_ADS_DEVELOPER_TOKEN_KEY } }))?.value ??
      null
  }
  const fromPlatform = parseGoogleAdsDeveloperToken(platformValue)
  if (fromPlatform) return { developerToken: fromPlatform, source: 'platform' }
  if (opts?.includeEnv === false) return null
  const fromEnv = readGoogleAdsDeveloperTokenFromEnv()
  return fromEnv ? { developerToken: fromEnv, source: 'env' } : null
}

/** A tokent soha nem adjuk vissza a UI-nak — csak azt, hogy be van-e állítva és honnan. */
export function toGoogleAdsDeveloperTokenPublicView(resolved: GoogleAdsDeveloperTokenResolved | null): {
  configured: boolean
  persisted: boolean
  source: GoogleAdsDeveloperTokenSource | null
  hint: string | null
} {
  if (!resolved) return { configured: false, persisted: false, source: null, hint: null }
  return {
    configured: true,
    persisted: resolved.source === 'platform',
    source: resolved.source,
    hint: `…${resolved.developerToken.slice(-4)}`,
  }
}

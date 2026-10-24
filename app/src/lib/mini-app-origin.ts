import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { signMiniAppLink } from '@/domain/mini-app/link-token'
import type { MiniAppLinks } from '@/domain/mini-app/mini-app-service'

/**
 * #967 D7: a mini app gyors linkje KÜLÖN originen fut (`MINI_APP_ORIGIN`, pl.
 * `https://apps.<domain>`), így a mini app JS-e a platform-sessiont nem éri el.
 * Beállítás nélkül (fejlesztés) a platform originje — élesben kötelező beállítani.
 */
export function miniAppOrigin(): string {
  const configured = process.env.MINI_APP_ORIGIN?.trim().replace(/\/$/, '')
  return configured || resolvePublicAppOrigin()
}

export function isSeparateMiniAppOrigin(): boolean {
  return Boolean(process.env.MINI_APP_ORIGIN?.trim())
}

export function miniAppPermanentUrl(appId: string): string {
  return `${resolvePublicAppOrigin()}/control-plane/mini-apps/${appId}`
}

export function miniAppOpenUrl(token: string): string {
  return `${miniAppOrigin()}/api/mini-apps/open/${token}`
}

export function mintMiniAppLinks(input: {
  tenantId: string
  appId: string
  version: number
  contentHash: string
  requesterUserId: string
  ttlMs: number
}): MiniAppLinks {
  const expiresAt = Date.now() + input.ttlMs
  const token = signMiniAppLink({ ...input, expiresAt })
  return {
    openUrl: miniAppOpenUrl(token),
    openUrlExpiresAt: new Date(expiresAt).toISOString(),
    permanentUrl: miniAppPermanentUrl(input.appId),
  }
}

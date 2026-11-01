import { verifyMiniAppLink, type MiniAppLinkPayload } from '@/domain/mini-app/link-token'
import {
  MINI_APP_COMMON_HEADERS,
  renderMiniAppExpiredPage,
  type MiniAppBarInput,
} from '@/domain/mini-app/frame'
import type { MiniAppRecord, MiniAppVersionRecord } from '@/domain/mini-app/types'
import { repositories } from '@/repositories/postgres'
import { isSeparateMiniAppOrigin, miniAppOrigin, miniAppPermanentUrl } from '@/lib/mini-app-origin'

export type ResolvedMiniAppLink =
  | { kind: 'ok'; payload: MiniAppLinkPayload; app: MiniAppRecord; version: MiniAppVersionRecord; bar: MiniAppBarInput }
  | { kind: 'gone'; permanentUrl: string | null; reason: 'expired' | 'invalid' }
  | { kind: 'not_found' }

/**
 * Gyors link feloldása (#967 §5.3). Cookie-t nem olvas: kizárólag az aláírt
 * token dönt. Lejárt, de hiteles tokennél a lejárt-oldal az állandó linkre mutat.
 */
export async function resolveMiniAppLink(token: string): Promise<ResolvedMiniAppLink> {
  const verdict = verifyMiniAppLink(token)
  if (!verdict.ok) {
    return verdict.reason === 'expired'
      ? { kind: 'gone', permanentUrl: miniAppPermanentUrl(verdict.payload.a), reason: 'expired' }
      : { kind: 'gone', permanentUrl: null, reason: 'invalid' }
  }
  const { payload } = verdict
  const app = await repositories.miniApps.findById(payload.t, payload.a)
  if (!app) return { kind: 'not_found' }
  // Archivált appra a már kiadott gyors link sem nyit (a megosztások is megszűnnek).
  if (app.status !== 'active') return { kind: 'gone', permanentUrl: miniAppPermanentUrl(app.id), reason: 'invalid' }
  const version = await repositories.miniApps.findVersion(app.id, payload.v)
  if (!version || version.contentHash !== payload.h) return { kind: 'not_found' }
  const owner = await repositories.agents.findById(app.ownerAgentId, app.tenantId)
  return {
    kind: 'ok',
    payload,
    app,
    version,
    bar: {
      name: app.name,
      createdAt: app.createdAt,
      versionCreatedAt: version.createdAt,
      ownerAgentName: owner?.name ?? 'AI munkatárs',
      version: version.version,
      currentVersion: app.currentVersion,
    },
  }
}

/** Külön originnél a mini app tartalmat csak azon szolgáljuk ki (D7) — a platform originjén 404. */
export function servedFromWrongOrigin(request: Request): boolean {
  if (!isSeparateMiniAppOrigin()) return false
  const expected = new URL(miniAppOrigin()).host
  const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const host = forwarded || request.headers.get('host') || new URL(request.url).host
  return host !== expected
}

export function miniAppHtmlResponse(body: string, status: number, csp: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      ...MINI_APP_COMMON_HEADERS,
      ...extra,
    },
  })
}

export function miniAppGoneResponse(resolved: { permanentUrl: string | null; reason: 'expired' | 'invalid' }): Response {
  return miniAppHtmlResponse(
    renderMiniAppExpiredPage(resolved),
    410,
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors *",
  )
}

export function miniAppNotFoundResponse(): Response {
  return new Response('Nem található.', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...MINI_APP_COMMON_HEADERS },
  })
}

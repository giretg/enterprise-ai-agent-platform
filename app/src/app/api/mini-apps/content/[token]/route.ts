import {
  buildMiniAppLiveDocument,
  MINI_APP_COMMON_HEADERS,
  MINI_APP_CONTENT_HEADERS,
  miniAppBoundContentFetchDecision,
  miniAppContentCsp,
  miniAppContentFetchDecision,
  withMiniAppHardening,
} from '@/domain/mini-app/frame'
import { serializeLiveData } from '@/domain/mini-app/data-binding'
import { checkLiveAccess, loadLiveData } from '@/domain/mini-app/live-data'
import { writeAudit } from '@/lib/audit/types'
import { miniAppLiveDeps } from '@/lib/mini-app-live'
import { miniAppOpenUrl } from '@/lib/mini-app-origin'
import {
  liveOpenAllowed,
  miniAppBusyResponse,
  miniAppGoneResponse,
  miniAppHtmlResponse,
  miniAppNotFoundResponse,
  resolveMiniAppLink,
  servedFromWrongOrigin,
} from '@/lib/mini-app-serve'
import { repositories } from '@/repositories/postgres'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * #967 §5.3: az agent HTML-je szigorú CSP-vel — hálózat nincs (`connect-src 'none'`),
 * saját opaque origin (`sandbox allow-scripts`), csak a keretoldal ágyazhatja be.
 * #1083 §4.2: kötött verziónál a friss adat itt, szerveroldalon kerül a HTML-be.
 * ponytail: álnév-feloldás (§5.4) még nincs — a HTML úgy megy ki, ahogy az agent beküldte.
 */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  if (servedFromWrongOrigin(request)) return miniAppNotFoundResponse()
  const { token } = await context.params
  const resolved = await resolveMiniAppLink(token)
  if (resolved.kind === 'not_found') return miniAppNotFoundResponse()
  if (resolved.kind === 'gone') return miniAppGoneResponse(resolved)
  const bound = resolved.version.dataBindings.length > 0
  const secFetchDest = request.headers.get('sec-fetch-dest')
  const decision = bound ? miniAppBoundContentFetchDecision(secFetchDest) : miniAppContentFetchDecision(secFetchDest)
  if (decision === 'reject') return miniAppNotFoundResponse()
  if (decision === 'open_frame') {
    return new Response(null, { status: 302, headers: { Location: miniAppOpenUrl(token), ...MINI_APP_COMMON_HEADERS } })
  }
  if (!bound) return miniAppHtmlResponse(withMiniAppHardening(resolved.version.html), 200, miniAppContentCsp(), MINI_APP_CONTENT_HEADERS)

  if (!liveOpenAllowed(resolved.payload)) return miniAppBusyResponse()
  const { app, version, payload } = resolved
  const access = await checkLiveAccess(miniAppLiveDeps, app, payload.u)
  if (!access.ok) {
    await audit(app, version.version, payload.u, { allowed: false, reason: access.code })
    return miniAppNotFoundResponse()
  }
  const live = await loadLiveData(miniAppLiveDeps, { app, userId: payload.u!, role: access.role, bindings: version.dataBindings, purpose: 'content' })
  await audit(app, version.version, payload.u, { allowed: true, rows: live.rows, bindings: Object.entries(live.data).map(([alias, block]) => ({ alias, status: block.status })) })
  const document = buildMiniAppLiveDocument(version.html, { dataJson: serializeLiveData(live.data) })
  return miniAppHtmlResponse(document.html, 200, document.csp, MINI_APP_CONTENT_HEADERS)
}

/** §5: minden megnyitás auditált; adat és szűrőérték nem kerül a naplóba. */
function audit(
  app: { id: string; tenantId: string },
  version: number,
  linkIssuedToUserId: string | undefined,
  input: { allowed: boolean; reason?: string; rows?: number; bindings?: Array<{ alias: string; status: string }> },
) {
  return writeAudit(repositories.audit, {
    actorType: 'system',
    actorId: null,
    action: 'mini_app.opened',
    targetType: 'mini_app',
    targetId: app.id,
    policyDecision: input.allowed ? 'allowed' : 'denied',
    metadata: {
      phase: 'live_data',
      version,
      linkIssuedToUserId: linkIssuedToUserId ?? null,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.rows !== undefined ? { rows: input.rows } : {}),
      ...(input.bindings ? { bindings: input.bindings } : {}),
    },
    tenantId: app.tenantId,
  })
}

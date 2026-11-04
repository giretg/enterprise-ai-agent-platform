import { miniAppFrameCsp, renderMiniAppFrame, type MiniAppLiveBar } from '@/domain/mini-app/frame'
import { checkLiveAccess, liveDeniedMessage, loadLiveData } from '@/domain/mini-app/live-data'
import { writeAudit } from '@/lib/audit/types'
import { miniAppLiveDeps } from '@/lib/mini-app-live'
import { miniAppContentUrl, miniAppOrigin } from '@/lib/mini-app-origin'
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
 * #967 §5.3: a gyors link keretoldala — információs sáv + sandboxolt iframe az
 * agent HTML-jével. Bejelentkezés nélkül, cookie nélkül; a token dönt.
 * #1083 §4.4: kötött verziónál a sáv élő adat állapotát is mutatja. Az állapothoz itt is
 * lefut a lekérdezés, mert a sáv a keretoldalon van, az adat pedig a tartalomban: másképp a
 * levágás és a hiba nem derülne ki. Gyorsítótár csak mérés után kell (§4.2).
 */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  if (servedFromWrongOrigin(request)) return miniAppNotFoundResponse()
  const { token } = await context.params
  const resolved = await resolveMiniAppLink(token)
  if (resolved.kind === 'not_found') return miniAppNotFoundResponse()
  if (resolved.kind === 'gone') return miniAppGoneResponse(resolved)
  const { app, version, payload } = resolved

  let live: MiniAppLiveBar | undefined
  let deniedCode: string | undefined
  if (version.dataBindings.length > 0) {
    if (!liveOpenAllowed(payload)) return miniAppBusyResponse()
    const access = await checkLiveAccess(miniAppLiveDeps, app, payload.u)
    if (access.ok) {
      live = (await loadLiveData(miniAppLiveDeps, { app, userId: payload.u!, role: access.role, bindings: version.dataBindings, purpose: 'status' })).bar
    } else {
      deniedCode = access.code
      live = { mode: 'denied', lastLoadAt: null, warnings: [liveDeniedMessage(access.code)] }
    }
  }

  await writeAudit(repositories.audit, {
    // A gyors link továbbadható: nem tudjuk, ki nyitotta meg, csak azt, kinek készült.
    actorType: 'system',
    actorId: null,
    action: 'mini_app.opened',
    targetType: 'mini_app',
    targetId: app.id,
    policyDecision: deniedCode ? 'denied' : 'allowed',
    metadata: {
      phase: 'opened',
      linkIssuedToUserId: payload.u ?? null,
      version: version.version,
      contentHash: version.contentHash,
      ...(live ? { live: live.mode } : {}),
      ...(deniedCode ? { deniedCode } : {}),
    },
    tenantId: app.tenantId,
  })
  const html = renderMiniAppFrame({
    ...resolved.bar,
    ...(live ? { live } : {}),
    contentUrl: miniAppContentUrl(token),
  })
  return miniAppHtmlResponse(html, 200, miniAppFrameCsp(miniAppOrigin()))
}

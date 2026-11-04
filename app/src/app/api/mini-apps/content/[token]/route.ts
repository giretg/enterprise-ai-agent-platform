import {
  MINI_APP_COMMON_HEADERS,
  MINI_APP_CONTENT_HEADERS,
  miniAppContentCsp,
  miniAppContentFetchDecision,
  withMiniAppHardening,
} from '@/domain/mini-app/frame'
import { miniAppOpenUrl } from '@/lib/mini-app-origin'
import {
  miniAppGoneResponse,
  miniAppHtmlResponse,
  miniAppNotFoundResponse,
  resolveMiniAppLink,
  servedFromWrongOrigin,
} from '@/lib/mini-app-serve'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * #967 §5.3: az agent HTML-je szigorú CSP-vel — hálózat nincs (`connect-src 'none'`),
 * saját opaque origin (`sandbox allow-scripts`), csak a keretoldal ágyazhatja be.
 * ponytail: álnév-feloldás (§5.4) még nincs — a HTML úgy megy ki, ahogy az agent beküldte.
 */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  if (servedFromWrongOrigin(request)) return miniAppNotFoundResponse()
  const { token } = await context.params
  const resolved = await resolveMiniAppLink(token)
  if (resolved.kind === 'not_found') return miniAppNotFoundResponse()
  if (resolved.kind === 'gone') return miniAppGoneResponse(resolved)
  const decision = miniAppContentFetchDecision(request.headers.get('sec-fetch-dest'))
  if (decision === 'reject') return miniAppNotFoundResponse()
  if (decision === 'open_frame') {
    return new Response(null, { status: 302, headers: { Location: miniAppOpenUrl(token), ...MINI_APP_COMMON_HEADERS } })
  }
  return miniAppHtmlResponse(withMiniAppHardening(resolved.version.html), 200, miniAppContentCsp(), MINI_APP_CONTENT_HEADERS)
}

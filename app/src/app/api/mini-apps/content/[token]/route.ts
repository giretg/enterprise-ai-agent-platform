import { miniAppContentCsp } from '@/domain/mini-app/frame'
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
  return miniAppHtmlResponse(resolved.version.html, 200, miniAppContentCsp())
}

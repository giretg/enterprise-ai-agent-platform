import { miniAppFrameCsp, renderMiniAppFrame } from '@/domain/mini-app/frame'
import { writeAudit } from '@/lib/audit/types'
import {
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
 */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  if (servedFromWrongOrigin(request)) return miniAppNotFoundResponse()
  const { token } = await context.params
  const resolved = await resolveMiniAppLink(token)
  if (resolved.kind === 'not_found') return miniAppNotFoundResponse()
  if (resolved.kind === 'gone') return miniAppGoneResponse(resolved)
  await writeAudit(repositories.audit, {
    // A gyors link továbbadható: nem tudjuk, ki nyitotta meg, csak azt, kinek készült.
    actorType: 'system',
    actorId: null,
    action: 'mini_app.opened',
    targetType: 'mini_app',
    targetId: resolved.app.id,
    policyDecision: 'allowed',
    metadata: { phase: 'opened', linkIssuedToUserId: resolved.payload.u ?? null, version: resolved.version.version, contentHash: resolved.version.contentHash },
    tenantId: resolved.app.tenantId,
  })
  const html = renderMiniAppFrame({
    ...resolved.bar,
    // Relatív: a tartalom mindig a keretoldallal azonos originről jön.
    contentUrl: `/api/mini-apps/content/${encodeURIComponent(token)}`,
  })
  return miniAppHtmlResponse(html, 200, miniAppFrameCsp())
}

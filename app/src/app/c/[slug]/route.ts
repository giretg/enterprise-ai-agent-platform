import { randomBytes } from 'node:crypto'
import { publicChatDeps } from '@/auth/public-chat-deps'
import { frameAncestorsFor, readWidgetDomains } from '@/domain/public-chat/config'
import { publicChatCsp, renderPublicChatPage } from '@/domain/public-chat/page'
import { loadPublicAssistantState } from '@/domain/public-chat/service'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * #1016 D9: a nyilvános chat oldala (link = teljes oldal, widget = ugyanez iframe-ben).
 * Clerk nélkül, a `slug`-ból a szerver oldja fel a tenantot; a CSP `frame-ancestors` a
 * tenant domain-listája (D10) — üres lista = idegen oldal nem keretezheti.
 */
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await context.params
  const url = new URL(request.url)
  const testToken = url.searchParams.get('t')
  const deps = publicChatDeps()
  const state = await loadPublicAssistantState(deps, { slug, testToken })
  const tenant =
    state.state === 'not_found' ? null : await prisma.tenant.findUnique({ where: { id: state.tenantId }, select: { settings: true } })
  const nonce = randomBytes(16).toString('base64')
  const siteKey = deps.verifyTurnstile ? process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null : null
  const html = renderPublicChatPage({
    state,
    slug: slug.toLowerCase(),
    nonce,
    testToken: state.state === 'ready' && state.isTest ? testToken : null,
    turnstileSiteKey: siteKey,
  })
  return new Response(html, {
    status: state.state === 'not_found' ? 404 : 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': publicChatCsp({
        nonce,
        frameAncestors: frameAncestorsFor(readWidgetDomains(tenant?.settings)),
        turnstile: Boolean(siteKey),
      }),
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
    },
  })
}

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/auth'
import { oauthReturnPath } from '@/domain/connector-grant/connector-grant-needed'
import { services } from '@/domain'
import { prisma } from '@/lib/db'
import { publicAppUrl } from '@/lib/public-app-url'

export async function GET(request: Request) {
  const user = await getCurrentUser().catch(() => null)
  if (!user) {
    return NextResponse.redirect(publicAppUrl('/sign-in', request))
  }

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    return redirectAfterOAuth(request, state, error)
  }

  if (!code || !state) {
    return redirectAfterOAuth(request, state, 'missing_code')
  }

  try {
    const { verifyOAuthState } = await import('@/lib/crypto/oauth-state')
    const statePayload = verifyOAuthState(state)
    const connector = await prisma.connector.findUnique({ where: { id: statePayload.connectorId } })
    if (!connector) throw new Error('connector_not_found')
    if (connector.lifecycleState !== 'active') throw new Error('connector_not_active')

    await services.connectorGrants.completeOAuthCallback({
      code,
      state,
      connector,
      actorId: user.id,
    })

    return redirectAfterOAuth(request, state)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'oauth_callback_failed'
    return redirectAfterOAuth(request, state, message)
  }
}

async function redirectAfterOAuth(request: Request, state: string | null, error?: string) {
  const fallback = error
    ? `/control-plane/connectors?error=${encodeURIComponent(error)}`
    : '/control-plane/connectors?connected=1'
  if (!state) {
    return NextResponse.redirect(publicAppUrl(fallback, request))
  }
  try {
    const { verifyOAuthState } = await import('@/lib/crypto/oauth-state')
    const payload = verifyOAuthState(state)
    if (payload.returnTo) {
      return NextResponse.redirect(
        publicAppUrl(oauthReturnPath(payload.returnTo, error ? { error } : undefined), request),
      )
    }
  } catch {
    // lejárt / sérült state — a connectors fallback marad
  }
  return NextResponse.redirect(publicAppUrl(fallback, request))
}

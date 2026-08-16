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
    return NextResponse.redirect(
      publicAppUrl(`/control-plane/connectors?error=${encodeURIComponent(error)}`, request),
    )
  }

  if (!code || !state) {
    return NextResponse.redirect(publicAppUrl('/control-plane/connectors?error=missing_code', request))
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

    const successPath = statePayload.returnTo
      ? oauthReturnPath(statePayload.returnTo)
      : '/control-plane/connectors?connected=1'
    return NextResponse.redirect(publicAppUrl(successPath, request))
  } catch (e) {
    const message = e instanceof Error ? e.message : 'oauth_callback_failed'
    return NextResponse.redirect(
      publicAppUrl(`/control-plane/connectors?error=${encodeURIComponent(message)}`, request),
    )
  }
}

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/auth'
import { services } from '@/domain'
import { prisma } from '@/lib/db'

export async function GET(request: Request) {
  const user = await getCurrentUser().catch(() => null)
  if (!user) {
    return NextResponse.redirect(new URL('/sign-in', request.url))
  }

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    return NextResponse.redirect(
      new URL(`/control-plane/connectors?error=${encodeURIComponent(error)}`, request.url),
    )
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL('/control-plane/connectors?error=missing_code', request.url))
  }

  try {
    const { verifyOAuthState } = await import('@/lib/crypto/oauth-state')
    const statePayload = verifyOAuthState(state)
    const connector = await prisma.connector.findUnique({ where: { id: statePayload.connectorId } })
    if (!connector) throw new Error('connector_not_found')

    await services.connectorGrants.completeOAuthCallback({
      code,
      state,
      connector,
      actorId: user.id,
    })

    return NextResponse.redirect(new URL('/control-plane/connectors?connected=1', request.url))
  } catch (e) {
    const message = e instanceof Error ? e.message : 'oauth_callback_failed'
    return NextResponse.redirect(
      new URL(`/control-plane/connectors?error=${encodeURIComponent(message)}`, request.url),
    )
  }
}

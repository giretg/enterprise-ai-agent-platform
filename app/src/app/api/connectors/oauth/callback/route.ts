import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/auth'
import { requireTenantRole } from '@/auth/tenant-context'
import { oauthReturnPath } from '@/domain/connector-grant/connector-grant-needed'
import { services } from '@/domain/gateway-services'
import { prisma } from '@/lib/db'
import { repositories } from '@/repositories/postgres'
import { publicAppUrl } from '@/lib/public-app-url'

export async function GET(request: Request) {
  const user = await getCurrentUser().catch(() => null)
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
    const { verifyOAuthState, resolveOAuthCallbackActor } = await import('@/lib/crypto/oauth-state')
    const statePayload = verifyOAuthState(state)
    const actorId = resolveOAuthCallbackActor(user?.id ?? null, statePayload.userId)
    if (statePayload.owner === 'tenant') {
      const admin = await requireTenantRole('admin')
      if (admin.user.id !== actorId || admin.activeTenantId !== statePayload.tenantId) {
        throw new Error('connector_grant_forbidden')
      }
    }
    const connector = await prisma.connector.findUnique({ where: { id: statePayload.connectorId } })
    if (!connector) throw new Error('connector_not_found')
    if (connector.lifecycleState !== 'active') throw new Error('connector_not_active')

    const grant = await services.connectorGrants.completeOAuthCallback({
      code,
      state,
      connector,
      actorId,
    })
    if (statePayload.owner === 'tenant') {
      // #1028: közös postafiók bekötése — ki kötötte be (csak audit, a hozzáférést nem befolyásolja).
      await repositories.audit.append({
        actorType: 'human',
        actorId,
        agentVersion: null,
        action: 'connector.mailbox.connect',
        targetType: 'connector',
        targetId: connector.id,
        modelUsed: null,
        inputRef: null,
        outputRef: grant.accountLabel,
        policyDecision: 'allowed',
        metadata: { address: grant.accountLabel, grantId: grant.id },
        tenantId: connector.tenantId,
      })
    }

    return redirectAfterOAuth(request, state)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'oauth_callback_failed'
    return redirectAfterOAuth(request, state, message)
  }
}

async function redirectAfterOAuth(request: Request, state: string | null, error?: string) {
  const fallback = error
    ? `/control-plane/account?error=${encodeURIComponent(error)}`
    : '/control-plane/account?connected=1'
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

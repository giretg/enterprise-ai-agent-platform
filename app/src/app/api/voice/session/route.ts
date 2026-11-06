import { NextResponse } from 'next/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { voiceSessionDeps } from '@/auth/voice-deps'
import { startVoiceSession, type VoiceSessionFailureCode } from '@/domain/voice/session'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const STATUS: Record<VoiceSessionFailureCode, number> = {
  bad_request: 400,
  agent_unavailable: 403,
  voice_disabled: 403,
  key_missing: 403,
  not_configured: 503,
  provider_key_rejected: 502,
  provider_no_access: 502,
  provider_quota: 502,
  provider_error: 502,
}

/** #1111: böngészős hang-beszélgetés indítása. A kulcs és az MCP-token a szerveren marad. */
export async function POST(request: Request): Promise<Response> {
  const origin = resolvePublicAppOrigin(request)
  if (request.headers.get('origin') !== origin) return NextResponse.json({ error: 'bad_origin' }, { status: 403 })
  let ctx: Awaited<ReturnType<typeof requireTenantRole>>
  try {
    ctx = await requireTenantRole('viewer')
  } catch {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }
  const result = await startVoiceSession(voiceSessionDeps(origin), {
    userId: ctx.user.id,
    tenantId: ctx.activeTenantId,
    role: ctx.activeTenantRole,
    body: await request.json().catch(() => null),
  })
  if (!result.ok) return NextResponse.json({ error: result.code }, { status: STATUS[result.code] })
  return NextResponse.json(
    { sessionId: result.sessionId, sdpAnswer: result.sdpAnswer, greeting: result.greeting, maxSeconds: result.maxSeconds },
    { headers: { 'cache-control': 'no-store' } },
  )
}

import { NextResponse } from 'next/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { voiceSessionEndDeps } from '@/auth/voice-deps'
import { recordVoiceSessionEnd } from '@/domain/voice/session'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** #1111: a böngésző jelenti a beszélgetés végét és a mért várakozást az auditba. */
export async function POST(request: Request): Promise<Response> {
  if (request.headers.get('origin') !== resolvePublicAppOrigin(request)) {
    return NextResponse.json({ error: 'bad_origin' }, { status: 403 })
  }
  let ctx: Awaited<ReturnType<typeof requireTenantRole>>
  try {
    ctx = await requireTenantRole('viewer')
  } catch {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }
  const result = await recordVoiceSessionEnd(
    voiceSessionEndDeps(),
    { userId: ctx.user.id, tenantId: ctx.activeTenantId, body: await request.json().catch(() => null) },
  )
  return NextResponse.json({ ok: result.ok }, { status: result.ok ? 200 : 400 })
}

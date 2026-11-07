import { NextResponse } from 'next/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { voiceSessionEndDeps } from '@/auth/voice-deps'
import { recordVoiceSessionEnd } from '@/domain/voice/session'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { readBoundedJson, RequestTooLargeError } from '@/lib/request-body'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * A böngésző-jelentés felső határa az átirat sémakorlátja: 300 sor × 8000 karakter, többbájtos
 * UTF-8-cal is bőven belefér 12 MB-ba. A séma (session.ts) ezen belül a valódi limiter; ez a plafon
 * csak a határtalan `request.json()`-parse okozta OOM-ot zárja ki (vö. #1081).
 */
const VOICE_END_MAX_BODY_BYTES = 12 * 1024 * 1024

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
  let body: unknown
  try {
    body = await readBoundedJson(request, VOICE_END_MAX_BODY_BYTES)
  } catch (error) {
    // Túl nagy törzs → 413 (OOM ellen); érvénytelen JSON → null, a domain ok:false-ot ad (400).
    if (error instanceof RequestTooLargeError) return NextResponse.json({ ok: false }, { status: 413 })
    body = null
  }
  const result = await recordVoiceSessionEnd(
    voiceSessionEndDeps(),
    { userId: ctx.user.id, tenantId: ctx.activeTenantId, body },
  )
  return NextResponse.json({ ok: result.ok }, { status: result.ok ? 200 : 400 })
}

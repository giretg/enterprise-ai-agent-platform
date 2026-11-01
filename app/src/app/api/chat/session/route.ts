import { NextResponse } from 'next/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { chatSessionDeps } from '@/auth/platform-chat-deps'
import { issueChatSession, type ChatSessionFailureCode } from '@/domain/platform-chat/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const STATUS: Record<ChatSessionFailureCode, number> = {
  unauthenticated: 401,
  platform_chat_disabled: 403,
  key_missing: 403,
  agent_unavailable: 403,
  not_configured: 503,
  bad_request: 400,
}

/** #1004 §4.3: Clerk-session → 10 perces chat-token a platform-chat workerhez. */
export async function POST(request: Request): Promise<Response> {
  let ctx: Awaited<ReturnType<typeof requireTenantRole>>
  try {
    ctx = await requireTenantRole('viewer')
  } catch {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown> | null
  const result = await issueChatSession(chatSessionDeps(), {
    userId: ctx.user.id,
    tenantId: ctx.activeTenantId,
    role: ctx.activeTenantRole,
    agentId: body?.agentId,
  })
  if (!result.ok) return NextResponse.json({ error: result.code }, { status: STATUS[result.code] })
  const { ok: _ok, ...payload } = result
  return NextResponse.json(payload, { headers: { 'cache-control': 'no-store' } })
}

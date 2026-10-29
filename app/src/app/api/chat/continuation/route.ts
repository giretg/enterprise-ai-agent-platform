import { NextResponse } from 'next/server'
import { continuationDeps } from '@/auth/platform-chat-deps'
import { issueContinuationToken, type ChatSessionFailureCode } from '@/domain/platform-chat/session'

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

/** #1004 §7: a worker a chat-tokennel kér fordulóra szűkített folytatási tokent (háttérfutás). */
export async function POST(request: Request): Promise<Response> {
  const result = await issueContinuationToken(continuationDeps(), {
    authorizationHeader: request.headers.get('authorization'),
    body: await request.json().catch(() => null),
  })
  if (!result.ok) return NextResponse.json({ error: result.code }, { status: STATUS[result.code] })
  return NextResponse.json({ token: result.token, expiresAt: result.expiresAt }, { headers: { 'cache-control': 'no-store' } })
}

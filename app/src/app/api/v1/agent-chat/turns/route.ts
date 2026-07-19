import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { isAgentTurnAccessible } from '@/lib/agent-turn-access'
import { repositories } from '@/repositories/postgres'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * `GET /api/v1/agent-chat/turns?conversationId=…&active=1` — van-e futó forduló?
 * (spec §6.4)
 */
export async function GET(request: Request) {
  let user: Awaited<ReturnType<typeof requireTenantRole>>
  try {
    user = await requireTenantRole('operator')
  } catch {
    return new Response('Unauthorized', { status: 401 })
  }

  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId')
  const active = url.searchParams.get('active')

  if (!conversationId) {
    return Response.json({ error: 'conversationId is required' }, { status: 400 })
  }
  if (active !== '1' && active !== 'true') {
    return Response.json({ error: 'Only active=1 is supported' }, { status: 400 })
  }

  try {
    await services.conversations.getConversation(conversationId, user.activeTenantId)
  } catch {
    return new Response('Conversation not found', { status: 404 })
  }

  const turn = await repositories.agentTurns.findActiveByConversation(conversationId)
  if (!turn) {
    return Response.json({ active: false, turn: null })
  }

  if (!isAgentTurnAccessible(turn, user)) {
    return new Response('Forbidden', { status: 403 })
  }

  return Response.json({
    active: true,
    turn: {
      id: turn.id,
      conversationId: turn.conversationId,
      agentId: turn.agentId,
      status: turn.status,
      partialText: turn.partialText,
      activities: turn.activities,
      userMessageId: turn.userMessageId,
      startedAt: turn.startedAt.toISOString(),
      cancelRequested: turn.cancelRequested,
    },
  })
}

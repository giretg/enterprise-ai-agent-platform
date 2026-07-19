import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { requestChatTurnCancel } from '@/lib/agent-chat-active-turn-registry'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Conversation-scoped Stop (kompatibilitás). Megkeresi az aktív fordulót,
 * DB `cancelRequested`-et ír, és in-memory jelez (Tier-1 gyorsút).
 */
export async function POST(request: Request) {
  let user: Awaited<ReturnType<typeof requireTenantRole>>
  try {
    user = await requireTenantRole('operator')
  } catch {
    return new Response('Unauthorized', { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('Invalid JSON body', { status: 400 })
  }

  const { conversationId } = body as { conversationId?: string }
  if (!conversationId || typeof conversationId !== 'string') {
    return new Response('conversationId is required', { status: 400 })
  }

  try {
    await services.conversations.getConversation(conversationId, user.activeTenantId)
  } catch {
    return new Response('Conversation not found', { status: 404 })
  }

  const turn = await repositories.agentTurns.findActiveByConversation(conversationId)
  if (!turn) {
    return new Response('No active turn for conversation', { status: 404 })
  }

  const cancelled = await repositories.agentTurns.requestCancel(turn.id, user.user.id)
  if (!cancelled) {
    return new Response('No active turn for conversation', { status: 404 })
  }

  requestChatTurnCancel(conversationId)
  return new Response(null, { status: 202 })
}

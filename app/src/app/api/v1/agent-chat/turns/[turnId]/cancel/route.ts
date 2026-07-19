import { requireTenantRole } from '@/auth/tenant-context'
import { repositories } from '@/repositories/postgres'
import { requestChatTurnCancel } from '@/lib/agent-chat-active-turn-registry'
import { isAgentTurnAccessible } from '@/lib/agent-turn-access'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Turn-scoped Stop (spec §6.2 / D6): DB `cancelRequested` + in-memory jelzés.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ turnId: string }> },
) {
  let user: Awaited<ReturnType<typeof requireTenantRole>>
  try {
    user = await requireTenantRole('operator')
  } catch {
    return new Response('Unauthorized', { status: 401 })
  }

  const { turnId } = await context.params
  if (!turnId) {
    return new Response('turnId is required', { status: 400 })
  }

  const turn = await repositories.agentTurns.findById(turnId)
  if (!turn) {
    return new Response('Turn not found', { status: 404 })
  }

  if (!isAgentTurnAccessible(turn, user)) {
    return new Response('Forbidden', { status: 403 })
  }

  const cancelled = await repositories.agentTurns.requestCancel(turn.id, user.user.id)
  if (!cancelled) {
    return new Response('Turn is not active', { status: 404 })
  }

  requestChatTurnCancel(turn.conversationId)
  return new Response(null, { status: 202 })
}

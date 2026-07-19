import { requireTenantRole } from '@/auth/tenant-context'
import { agentTurnRunner, type AgentChatStreamEvent } from '@/domain/agent/agent-turn-runner'
import { isAgentTurnAccessible } from '@/lib/agent-turn-access'
import { repositories } from '@/repositories/postgres'
import { ACTIVE_AGENT_TURN_STATUSES } from '@/repositories/interfaces'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const fetchCache = 'force-no-store'

const DB_POLL_MS = 750

function isTerminalStatus(status: string): boolean {
  return !(ACTIVE_AGENT_TURN_STATUSES as readonly string[]).includes(status)
}

function isTerminalEvent(event: AgentChatStreamEvent): boolean {
  return event.type === 'done' || event.type === 'cancelled' || event.type === 'error'
}

function sseEncode(encoder: TextEncoder, data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
}

function terminalEventForTurn(turn: {
  id: string
  status: string
  conversationId: string
  assistantMessageId: string | null
  error: string | null
  reason: string | null
}): AgentChatStreamEvent {
  if (turn.status === 'cancelled' && turn.assistantMessageId) {
    return {
      type: 'cancelled',
      conversationId: turn.conversationId,
      messageId: turn.assistantMessageId,
    }
  }
  if (turn.assistantMessageId) {
    return {
      type: 'done',
      conversationId: turn.conversationId,
      messageId: turn.assistantMessageId,
    }
  }
  if (turn.status === 'failed') {
    return {
      type: 'error',
      message: turn.error ?? turn.reason ?? 'A forduló hibával zárult.',
    }
  }
  return {
    type: 'done',
    conversationId: turn.conversationId,
    messageId: turn.assistantMessageId ?? turn.id,
  }
}

/**
 * Reconnect SSE (spec §6.3): előbb snapshot a DB-ből, majd élő delta
 * (Tier-1 bus) vagy ~750ms DB-poll fallback.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ turnId: string }> },
) {
  let user: Awaited<ReturnType<typeof requireTenantRole>>
  try {
    user = await requireTenantRole('operator')
  } catch {
    return new Response('Unauthorized', { status: 401 })
  }

  const { turnId } = await context.params
  const turn = await repositories.agentTurns.findById(turnId)
  if (!turn) {
    return new Response('Turn not found', { status: 404 })
  }
  if (!isAgentTurnAccessible(turn, user)) {
    return new Response('Forbidden', { status: 403 })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (event: AgentChatStreamEvent): boolean => {
        controller.enqueue(sseEncode(encoder, event))
        return isTerminalEvent(event)
      }

      try {
        enqueue({
          type: 'snapshot',
          turnId: turn.id,
          status: turn.status,
          partialText: turn.partialText,
          activities: turn.activities,
          conversationId: turn.conversationId,
          userMessageId: turn.userMessageId,
        })

        if (isTerminalStatus(turn.status)) {
          enqueue(terminalEventForTurn(turn))
          return
        }

        await subscribeOrPoll(turnId, turn.conversationId, request.signal, enqueue)
      } catch (err) {
        if (!request.signal.aborted) {
          const message = err instanceof Error ? err.message : 'Reconnect stream failed'
          controller.enqueue(sseEncode(encoder, { type: 'error', message }))
        }
      } finally {
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

async function subscribeOrPoll(
  turnId: string,
  conversationId: string,
  signal: AbortSignal,
  enqueue: (event: AgentChatStreamEvent) => boolean,
): Promise<void> {
  const live = agentTurnRunner.subscribe(turnId)
  if (live) {
    for await (const event of live) {
      if (signal.aborted) return
      if (event.type === 'turn' || event.type === 'meta' || event.type === 'conflict') continue
      if (enqueue(event)) return
    }
    return
  }

  let lastPartial = ''
  let lastActivityCount = 0
  while (!signal.aborted) {
    const current = await repositories.agentTurns.findById(turnId)
    if (!current) {
      enqueue({ type: 'error', message: 'Turn disappeared' })
      return
    }

    if (current.partialText !== lastPartial) {
      const delta = current.partialText.slice(lastPartial.length)
      if (delta) enqueue({ type: 'token', chunk: delta })
      lastPartial = current.partialText
    }
    const activities = Array.isArray(current.activities) ? current.activities : []
    if (activities.length > lastActivityCount) {
      for (const activity of activities.slice(lastActivityCount)) {
        enqueue({ type: 'activity', activity: activity as never })
      }
      lastActivityCount = activities.length
    }

    if (isTerminalStatus(current.status)) {
      enqueue(terminalEventForTurn({ ...current, conversationId }))
      return
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, DB_POLL_MS)
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}

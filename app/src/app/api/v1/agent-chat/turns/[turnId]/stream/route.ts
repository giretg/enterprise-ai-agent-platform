import { agentTurnRunner, type AgentChatStreamEvent } from '@/domain/agent/agent-turn-runner'
import {
  resolveReconnectPollMs,
  streamTurnReconnect,
} from '@/domain/agent/agent-turn-reconnect'
import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import { isAgentTurnAccessible } from '@/lib/agent-turn-access'
import { repositories } from '@/repositories/postgres'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const fetchCache = 'force-no-store'

function sseEncode(encoder: TextEncoder, data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
}

/**
 * Reconnect SSE (spec §6.3): előbb snapshot a DB-ből, majd élő delta
 * (Tier-1 busz) vagy DB-poll fallback (E10). A folyam-mag az
 * `agent-turn-reconnect` modulban van, ez csak a hitelesítés + SSE-kódolás.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ turnId: string }> },
) {
  const auth = await requireTenantApiUser('operator')
  if (!auth.ok) return auth.response
  const { user } = auth

  const { turnId } = await context.params
  const turn = await repositories.agentTurns.findById(turnId)
  if (!turn) {
    return new Response('Turn not found', { status: 404 })
  }
  if (!isAgentTurnAccessible(turn, user)) {
    return new Response('Forbidden', { status: 403 })
  }

  const encoder = new TextEncoder()
  const pollMs = resolveReconnectPollMs()

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const events = streamTurnReconnect(turn, {
          findById: (id) => repositories.agentTurns.findById(id),
          subscribe: (id) => agentTurnRunner.subscribe(id),
          signal: request.signal,
          pollMs,
        })
        for await (const event of events) {
          if (request.signal.aborted) return
          controller.enqueue(sseEncode(encoder, event))
        }
      } catch (err) {
        if (!request.signal.aborted) {
          const message = err instanceof Error ? err.message : 'Reconnect stream failed'
          const errorEvent: AgentChatStreamEvent = { type: 'error', message }
          controller.enqueue(sseEncode(encoder, errorEvent))
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

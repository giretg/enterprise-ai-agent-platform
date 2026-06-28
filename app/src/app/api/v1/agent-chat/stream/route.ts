import { requireRole } from '@/auth'
import { services } from '@/domain'

// SSE: dinamikus, Node runtime, ne bufferelődjön / cache-elődjön a stream.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const fetchCache = 'force-no-store'

export async function POST(request: Request) {
  let user: Awaited<ReturnType<typeof requireRole>>
  try {
    user = await requireRole('operator')
  } catch {
    return new Response('Unauthorized', { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('Invalid JSON body', { status: 400 })
  }

  const { agentId, content, conversationId, attachmentDocumentIds } = body as {
    agentId?: string
    content?: string
    conversationId?: string
    attachmentDocumentIds?: string[]
  }

  if (!agentId || typeof agentId !== 'string') {
    return new Response('agentId is required', { status: 400 })
  }
  if (typeof content !== 'string') {
    return new Response('content is required', { status: 400 })
  }

  const encoder = new TextEncoder()

  function sseEvent(data: unknown): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const gen = services.agentChat.sendMessageStream({
          agentId,
          content,
          createdById: user.id,
          tenantId: user.tenantId,
          conversationId,
          attachmentDocumentIds,
        })

        for await (const event of gen) {
          controller.enqueue(sseEvent(event))
          if (event.type === 'done' || event.type === 'error') break
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Stream failed'
        controller.enqueue(sseEvent({ type: 'error', message }))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx / reverse-proxy bufferelés kikapcsolása, hogy a chunkok azonnal menjenek.
      'X-Accel-Buffering': 'no',
    },
  })
}

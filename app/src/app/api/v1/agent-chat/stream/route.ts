import { after } from 'next/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { agentTurnRunner } from '@/domain/agent/agent-turn-runner'

// SSE: dinamikus, Node runtime, ne bufferelődjön / cache-elődjön a stream.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const fetchCache = 'force-no-store'

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

  const { agentId, content, conversationId, attachmentDocumentIds, processDefinitionId, processInputPayload } = body as {
    agentId?: string
    content?: string
    conversationId?: string
    attachmentDocumentIds?: string[]
    processDefinitionId?: string
    processInputPayload?: Record<string, unknown>
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

  // A forduló futása leválik erről a kérésről (chat-agent-turn-resilience-spec.md
  // D3): a lecsatlakozás nem szakítja meg. Node-processben ehhez elég a runner
  // saját promise-a, menedzselt futtatókörnyezetben viszont a válasz lezárása után
  // az instance befagyasztható — az `after` tartja életben a futást a lezárásáig.
  let releaseKeepAlive: () => void = () => {}
  after(
    new Promise<void>((resolve) => {
      releaseKeepAlive = resolve
    }),
  )

  const stream = new ReadableStream({
    async start(controller) {
      let turnCompletion: Promise<void> | null = null
      try {
        // A generátor létrehozása is a `try`-on BELÜL van: ha itt szinkron hiba
        // csúszna ki, a `finally` nélkül a keep-alive ígéret sosem rendeződne, és
        // az `after` a futtatókörnyezetet határtalanul életben tartaná.
        const gen = services.agentChat.sendMessageStream({
          agentId,
          content,
          createdById: user.user.id,
          tenantId: user.activeTenantId,
          conversationId,
          attachmentDocumentIds,
          processDefinitionId,
          processInputPayload,
        })

        for await (const event of gen) {
          // A forduló azonosítója a legelső esemény; innen ismerjük meg, melyik
          // futást kell a válasz lezárása után is életben tartani.
          if (event.type === 'turn') {
            turnCompletion = agentTurnRunner.completionOf(event.turnId)
          }
          if (request.signal.aborted) {
            break
          }
          controller.enqueue(sseEvent(event))
          if (event.type === 'done' || event.type === 'cancelled' || event.type === 'error') break
        }
      } catch (err) {
        if (!request.signal.aborted) {
          const message = err instanceof Error ? err.message : 'Stream failed'
          controller.enqueue(sseEvent({ type: 'error', message }))
        }
      } finally {
        try {
          controller.close()
        } catch {
          // A kliens megszakítása után a stream már lehet zárt.
        }
        // A kliens lecsatlakozása NEM megszakítás (D5): a futást a lezárásáig
        // megvárjuk, csak épp már nem küldünk neki semmit.
        if (turnCompletion) {
          void turnCompletion.finally(() => releaseKeepAlive())
        } else {
          releaseKeepAlive()
        }
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

import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'

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

  // Az aktív-forduló ütközést (D7/E5) még a SSE-válasz megnyitása ELŐTT kell
  // eldönteni, különben csak egy 200-as streamben tudnánk hibát jelezni. Ezért a
  // generátor első eseményét itt húzzuk le: ütközésnél `409` + az aktív forduló
  // azonosítója (a kliens erre csatlakozik rá), minden más esetben ez lesz a
  // stream első kimenő eseménye.
  let first: Awaited<ReturnType<typeof gen.next>> | null = null
  let firstError: unknown = null
  try {
    first = await gen.next()
  } catch (err) {
    // A váratlan hiba ugyanúgy SSE `error` eseményként megy ki, mint eddig — a
    // kliens stream-parsere ne egy nem várt státuszkódon akadjon el.
    firstError = err
  }

  if (first && !first.done && first.value.type === 'conflict') {
    // A generátor már visszatért, de a `finally`-ága csak a lezárással fut le.
    await gen.return(undefined)
    return Response.json(
      {
        error: 'active_turn_exists',
        message: 'Ehhez a beszélgetéshez már fut egy válasz.',
        conversationId: first.value.conversationId,
        activeTurnId: first.value.activeTurnId,
      },
      { status: 409 },
    )
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (firstError) throw firstError
        if (first && !first.done) {
          controller.enqueue(sseEvent(first.value))
          if (
            first.value.type === 'done' ||
            first.value.type === 'cancelled' ||
            first.value.type === 'error'
          ) {
            return
          }
        }
        for await (const event of gen) {
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

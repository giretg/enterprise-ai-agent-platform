import { after } from 'next/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { agentTurnRunner, type AgentChatStreamEvent } from '@/domain/agent/agent-turn-runner'

// SSE: dinamikus, Node runtime, ne bufferelődjön / cache-elődjön a stream.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const fetchCache = 'force-no-store'

/** A stream lezárását kiváltó események (a `turn`/`token`/… folytatódik). */
function isTerminalEvent(event: AgentChatStreamEvent): boolean {
  return event.type === 'done' || event.type === 'cancelled' || event.type === 'error'
}

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
  // MINDEN kilépési ágnak el kell engednie, különben az ígéret sosem rendeződik.
  let releaseKeepAlive: () => void = () => {}
  after(
    new Promise<void>((resolve) => {
      releaseKeepAlive = resolve
    }),
  )

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
    // Ezen az ágon nem nyílik stream, tehát a keep-alive-ot ITT kell elengedni:
    // nincs futás, amit életben kellene tartani.
    releaseKeepAlive()
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
      // Objektumban tartva, mert az értékadás closure-ben történik — egy sima
      // `let`-et a szűkítés a `finally`-ban `never`-re vinne.
      const run: { completion: Promise<void> | null } = { completion: null }
      /** Egy esemény kiküldése; `true`, ha ezzel a stream le is zárul. */
      const emit = (event: AgentChatStreamEvent): boolean => {
        // A forduló azonosítója a legelső esemény — és azt a 409-döntés miatt
        // már kihúztuk a ciklus elől, ezért a kezelése NEM élhet a `for await`
        // törzsében, különben pont az elsőre nem kapnánk `completion`-t.
        if (event.type === 'turn') {
          run.completion = agentTurnRunner.completionOf(event.turnId)
        }
        controller.enqueue(sseEvent(event))
        return isTerminalEvent(event)
      }

      try {
        if (firstError) throw firstError
        if (first && !first.done && emit(first.value)) return

        for await (const event of gen) {
          if (request.signal.aborted) break
          if (emit(event)) break
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
        if (run.completion) {
          void run.completion.finally(() => releaseKeepAlive())
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

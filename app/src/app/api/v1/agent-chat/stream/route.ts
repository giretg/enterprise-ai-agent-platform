import { after } from 'next/server'
import { services } from '@/domain'
import { agentTurnRunner, type AgentChatStreamEvent } from '@/domain/agent/agent-turn-runner'
import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import { readJson } from '@/lib/api-response'
import { agentChatStreamTurnInputSchema } from '@/lib/validators/actions'
import { embeddedContextToModelPrefix, readEmbedApps } from '@/lib/embed-apps'
import { resolveChatStreamProjectKey } from '@/lib/chat-stream-project-key'
import { startSseCommentHeartbeat } from '@/lib/sse-comment-heartbeat'
import { shouldBlockTaskOnlyWebChat } from '@/lib/task-only-ticket'
import { repositories } from '@/repositories/postgres'

// SSE: dinamikus, Node runtime, ne bufferelődjön / cache-elődjön a stream.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const fetchCache = 'force-no-store'

/** A stream lezárását kiváltó események (a `turn`/`token`/… folytatódik). */
function isTerminalEvent(event: AgentChatStreamEvent): boolean {
  return event.type === 'done' || event.type === 'error'
}

export async function POST(request: Request) {
  const auth = await requireTenantApiUser('operator')
  if (!auth.ok) return auth.response
  const { user } = auth

  let body: unknown
  try {
    body = await readJson(request)
  } catch {
    // Érvénytelen VAGY túl nagy törzs → 400 (nem indul forduló, nincs OOM-vektor).
    return new Response('Invalid JSON body', { status: 400 })
  }

  const {
    agentId,
    content,
    conversationId,
    attachmentDocumentIds,
    processDefinitionId,
    processInputPayload,
    consequenceApprovalIds,
    connectorGrantContinuation,
    taskBriefing,
    embeddedContext,
    projectKey,
  } = body as {
    agentId?: string
    content?: string
    conversationId?: string
    projectKey?: string
    attachmentDocumentIds?: string[]
    processDefinitionId?: string
    processInputPayload?: Record<string, unknown>
    consequenceApprovalIds?: string[]
    connectorGrantContinuation?: boolean
    taskBriefing?: { goal?: string; source?: string; constraint?: string; approval?: string } | null
    embeddedContext?: { appSlug?: string; label?: string; data?: unknown } | null
  }

  if (!agentId || typeof agentId !== 'string') {
    return new Response('agentId is required', { status: 400 })
  }
  if (typeof content !== 'string') {
    return new Response('content is required', { status: 400 })
  }

  // A kliens-vezérelt forduló-bemenet méret-kapui (DoS / OOM / költség). A
  // szerver-action utak már kapuzzák a szabad szöveget és a csatolmány-listát; ez
  // volt az egyetlen ingress határok nélkül. A folytatás-ágon a tartalmat a szerver
  // adja, de a nyers body-mezőket ott is ellenőrizzük: túlméretes csatolmány-lista
  // / briefing folytatáskor sem utazhat a fordulóval.
  const turnInput = agentChatStreamTurnInputSchema.safeParse({
    content,
    attachmentDocumentIds,
    taskBriefing,
    embeddedContext,
  })
  if (!turnInput.success) {
    return Response.json(
      {
        error: 'invalid_turn_input',
        message: 'Az üzenet, a briefing vagy a csatolmány-lista túl nagy vagy érvénytelen.',
      },
      { status: 400 },
    )
  }

  // #481 D4 — a beágyazó app kontextusát a SZERVER burkolja: a slugnak a tenant
  // allowlistjén kell lennie (különben bármely webes kliens hamis forrás-címkével
  // tolhatna szöveget a promptba), és a 8 kB-os kapu itt is érvényes.
  let modelContextPrefix: string | undefined
  if (turnInput.data.embeddedContext) {
    const tenant = await repositories.tenants.findById(user.activeTenantId)
    const wrapped = embeddedContextToModelPrefix(
      readEmbedApps(tenant?.settings),
      turnInput.data.embeddedContext,
    )
    if (!wrapped.ok) {
      return Response.json(
        {
          error: wrapped.reason === 'too_large' ? 'embedded_context_too_large' : 'embedded_app_not_allowed',
          message:
            wrapped.reason === 'too_large'
              ? 'A beágyazó alkalmazás túl nagy kontextust küldött (max 8 kB).'
              : 'Ez az alkalmazás nincs engedélyezve a beágyazott chathez.',
        },
        { status: wrapped.reason === 'too_large' ? 413 : 403 },
      )
    }
    modelContextPrefix = wrapped.prefix
  }

  // issue #97 — jóváhagyás utáni FOLYTATÁS. A gomb megnyomása eddig lefuttatta a
  // műveletet, de a felhasználó semmit nem látott belőle és a hátralévő lépések
  // is elmaradtak. Itt a szerver állítja össze a forduló szövegét a MÁR
  // jóváhagyott sorokból (a kliens csak azonosítót küld), és a forduló
  // „tainted"-ként indul, hogy a következő mellékhatás megint kapura essen.
  let continuationContent: string | null = null
  let continuationConversationId: string | null = null
  if (Array.isArray(consequenceApprovalIds) && consequenceApprovalIds.length > 0) {
    const continuation = await services.consequenceApproval.getApprovedContinuation(
      consequenceApprovalIds.filter((id): id is string => typeof id === 'string'),
      { id: user.user.id, tenantId: user.activeTenantId, role: user.activeTenantRole },
    )
    if (!continuation.ok) {
      return Response.json(
        { error: continuation.reason, message: 'A jóváhagyás folytatása nem indítható.' },
        { status: continuation.reason === 'approval_not_found' ? 404 : 400 },
      )
    }
    if (conversationId && conversationId !== continuation.continuation.conversationId) {
      return Response.json(
        { error: 'approval_conversation_mismatch', message: 'A jóváhagyás nem ehhez a beszélgetéshez tartozik.' },
        { status: 400 },
      )
    }
    continuationContent = continuation.continuation.prompt
    continuationConversationId = continuation.continuation.conversationId
  } else if (connectorGrantContinuation === true) {
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      return Response.json(
        { error: 'conversation_required', message: 'A hozzáférés utáni folytatáshoz beszélgetés kell.' },
        { status: 400 },
      )
    }
    const conversation = await repositories.conversations.findByIdForTenant(
      conversationId,
      user.activeTenantId,
    )
    if (!conversation) {
      return Response.json(
        { error: 'conversation_not_found', message: 'A beszélgetés nem található.' },
        { status: 404 },
      )
    }
    const { CONNECTOR_GRANT_NEEDED_CHAT_PROMPT } = await import(
      '@/domain/connector-grant/connector-grant-needed'
    )
    continuationContent = CONNECTOR_GRANT_NEEDED_CHAT_PROMPT
    continuationConversationId = conversationId
  }

  // A projectKey a memória/audit hatóköre, ezért csak kiosztható kulcs mehet
  // tovább — a beszélgetéshez már kötött kulcs archiválás után is marad.
  let boundConversation: { projectKey: string | null } | null = null
  if (
    !continuationContent &&
    typeof conversationId === 'string' &&
    conversationId &&
    typeof projectKey === 'string' &&
    projectKey.trim()
  ) {
    boundConversation = await repositories.conversations.findByIdForTenant(
      conversationId,
      user.activeTenantId,
    )
  }
  const assignedProject = await resolveChatStreamProjectKey({
    projectKey,
    skip: Boolean(continuationContent),
    conversation: boundConversation,
    assignableKey: (raw) => services.workProjects.assignableKey(user.activeTenantId, raw),
  })
  if (!assignedProject.ok) {
    return Response.json(
      { error: 'invalid_work_project', message: assignedProject.reason },
      { status: 400 },
    )
  }
  const assignedProjectKey = assignedProject.key

  // Feladatkör-korlátozás (#199): korlátozott agentnél a WEBES chat-felületről nem
  // indítható ÚJ forduló — kivéve a Ticket → Megbeszélés (#219) beszélgetést, ahol
  // a ticket előzményéről kell tudni beszélgetni. Ez UI-egyszerűsítés, nem
  // jogosultsági korlát: a már futó forduló végigfut (`/turns/[turnId]/stream`,
  // `/cancel`), a meglévő beszélgetések olvashatók, és a nem-emberi belépési
  // pontok (agent_ask, csatorna-integrációk, agent API-kulcs, monitor-eszkaláció)
  // érintetlenül maradnak — ezért a kapu itt, a felhasználói kérés-úton áll, nem
  // a chat-runtime-ban.
  const targetAgent = await repositories.agents.findById(agentId, user.activeTenantId)
  if (targetAgent?.taskOnly) {
    let continuedFromTicketId: string | null = null
    const effectiveConversationId = continuationConversationId ?? conversationId
    if (typeof effectiveConversationId === 'string') {
      const conversation = await repositories.conversations.findByIdForTenant(
        effectiveConversationId,
        user.activeTenantId,
      )
      continuedFromTicketId = conversation?.continuedFromTicketId ?? null
    }
    if (shouldBlockTaskOnlyWebChat({ taskOnly: true, continuedFromTicketId })) {
      return Response.json(
        {
          error: 'agent_task_only',
          message:
            'Ez az agent korlátozott feladatkörű — feladatot az agent oldalán lévő feladat-gombbal indíthatsz.',
        },
        { status: 409 },
      )
    }
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
    content: continuationContent ?? content,
    createdById: user.user.id,
    tenantId: user.activeTenantId,
    conversationId: continuationConversationId ?? conversationId,
    ...(assignedProjectKey ? { projectKey: assignedProjectKey } : {}),
    // Folytatáskor a kliens csak azonosítót küld: se csatolmány, se folyamat-indítás
    // nem utazhat vele — a forduló tartalmát teljes egészében a szerver adja.
    ...(continuationContent
      ? {
          consequenceApprovalContinuation: true,
          ...(connectorGrantContinuation === true ? { connectorGrantContinuation: true } : {}),
        }
      : {
          attachmentDocumentIds,
          processDefinitionId,
          processInputPayload,
          ...(modelContextPrefix ? { modelContextPrefix } : {}),
          ...(taskBriefing &&
          typeof taskBriefing === 'object' &&
          typeof taskBriefing.goal === 'string'
            ? {
                taskBriefing: {
                  goal: taskBriefing.goal,
                  source: typeof taskBriefing.source === 'string' ? taskBriefing.source : '',
                  constraint: typeof taskBriefing.constraint === 'string' ? taskBriefing.constraint : '',
                  approval: typeof taskBriefing.approval === 'string' ? taskBriefing.approval : '',
                },
              }
            : {}),
        }),
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

      const heartbeat = startSseCommentHeartbeat(controller, encoder)

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
        clearInterval(heartbeat)
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

import { NextResponse } from 'next/server'
import { authenticateAgentRequest, requireAgentScope } from '@/auth/agent-api-key'
import { services } from '@/domain'
import { assertAgentWorkTenantOperable } from '@/lib/agent-work-tenant-gate'
import { isAgentApiToolContextOwnedByAgent } from '@/lib/agent-api-tool-context'
import { repositories } from '@/repositories/postgres'
import { toolInvokeSchema } from '@/lib/validators/actions'
import { buildToolInvokeInput } from '@/domain/tool-broker/tool-registry'
import { readJson } from '@/lib/api-response'
import { recordDenied } from '@/domain/tool-broker/tool-broker-audit'
import { prisma } from '@/lib/db'

function jsonError(message: string, status: number, data?: unknown) {
  return NextResponse.json({ success: false, error: message, data }, { status })
}

export async function POST(request: Request) {
  const auth = await authenticateAgentRequest(request.headers.get('authorization'))
  if (!auth) return jsonError('Unauthorized', 401)

  try {
    requireAgentScope(auth, 'tool:invoke')
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : 'Forbidden', 403)
  }

  let body: unknown
  try {
    body = await readJson(request)
  } catch {
    return jsonError('Invalid JSON body', 400)
  }

  const parsed = toolInvokeSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.message, 400)
  }

  try {
    const agent = await repositories.agents.findById(auth.agentId)
    if (!agent) return jsonError('Agent not found', 404)

    const invokeInput = buildToolInvokeInput(
      parsed.data.tool,
      (parsed.data.args ?? {}) as Record<string, unknown>,
      {
        agentId: auth.agentId,
        agentVersion: agent.currentVersion,
        ...(parsed.data.ticketId ? { ticketId: parsed.data.ticketId } : {}),
        ...(parsed.data.conversationId ? { conversationId: parsed.data.conversationId } : {}),
      },
    )
    // A descriptor által generált schema board_write-nál garantálja a ticketId-t;
    // a `toolInvokeSchema` közös Zod-típusa viszont az args-ot szándékosan unknownként tartja.
    const boardTargetTicketId =
      parsed.data.tool === 'board_write'
        ? (parsed.data.args as { ticketId: string }).ticketId
        : undefined
    const effectiveTicketId = boardTargetTicketId ?? parsed.data.ticketId
    const referencedTicketIds = [
      parsed.data.ticketId,
      ...(boardTargetTicketId ? [boardTargetTicketId] : []),
    ].filter((ticketId): ticketId is string => typeof ticketId === 'string')

    // A végrehajtási ticket/conversation a hívó által küldött azonosító. A file-
    // és workspace-toolok ebből választják a tárolási tenantot, ezért az API-
    // kulcsos útvonalon nem elég az agent capability-je: a kontextusnak is a kulcs
    // agentjéhez kell tartoznia. A Run Analyst saját args-beli scope-szűrői nem
    // ilyenek — azok tenanton belül szándékosan más agent futásait is kijelölhetik.
    // Ezt a kaput a tenant-státusz ellenőrzése ELŐTT nézzük, hogy idegen ticketből
    // státusz-információ se szivároghasson.
    const ownsContext = await isAgentApiToolContextOwnedByAgent(
      {
        agentId: auth.agentId,
        ticketIds: referencedTicketIds,
        conversationId: parsed.data.conversationId,
      },
      {
        findTicketOwner: async (ticketId) => {
          const ticket = await repositories.tickets.findById(ticketId)
          return ticket ? { agentId: ticket.agentId } : null
        },
        findConversationOwner: async (conversationId) =>
          prisma.conversation.findUnique({
            where: { id: conversationId },
            select: { agentId: true },
          }),
      },
    )
    if (!ownsContext) {
      // A kísérlet maga is biztonsági esemény. A külső azonosítót nem tesszük
      // audit-célobjektummá (így nem keverünk idegen tenantot a hívó nyomába),
      // de a ToolCall + append-only `tool.call.denied` sor megmarad.
      await recordDenied(
        services.toolBroker,
        { ...invokeInput, ticketId: undefined, conversationId: undefined },
        null,
        null,
        'agent_api_context_not_accessible',
        Date.now(),
      )
      return jsonError('Az eszközhívás kontextusa nem ehhez az agenthez tartozik.', 403)
    }

    const tenantGate = await assertAgentWorkTenantOperable({
      agentId: auth.agentId,
      ticketId: effectiveTicketId,
    })
    if (!tenantGate.ok) {
      return jsonError(`Tenant is not operable (${tenantGate.tenantStatus})`, 403, tenantGate)
    }

    // A tipizált broker-inputot a kanonikus regiszter állítja elő (issue #194):
    // ugyanaz a leképezés fut itt, mint a chat-úton, így a két út nem tud
    // elcsúszni egymástól.
    //
    // Az API-kulcs csak az agentet hitelesíti, felhasználót nem. Az
    // actingUserId ezért kizárólag a szerveroldal által létrehozott chat- vagy
    // futási kontextusból érkezhet, nem az agent által beküldött JSON-ból —
    // ezért nem adjuk át a kontextusnak.
    const result = await services.toolBroker.invoke({
      ...invokeInput,
      actingUserSource: 'external_agent_api',
    })

    if (result.denied) {
      return jsonError(result.reason, 403, result)
    }

    // issue #195 D5 — ez GÉPI fogyasztó: a `machineData` (a `result` alias-a) megy
    // ki, a modellnek szánt, BURKOLT `modelText` SOHA. Így a védőburkolat nem
    // kerülhet gépi útra, és a válasz nem hordozza háromszor ugyanazt az adatot.
    // A kimenetel viszont ide is kell: a hívó agent enélkül nem tudná meg, hogy
    // az eszköz „sikeresen semmit nem csinált".
    return NextResponse.json({
      success: true,
      data: {
        denied: false,
        trust: result.trust,
        outcome: result.outcome,
        outcomeReason: result.outcomeReason,
        effect: result.effect,
        result: result.machineData,
        resultMeta: result.resultMeta,
        latencyMs: result.latencyMs,
      },
    })
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : 'Tool invocation failed', 500)
  }
}

import { NextResponse } from 'next/server'
import { authenticateAgentRequest, requireAgentScope } from '@/auth/agent-api-key'
import { services } from '@/domain'
import { assertAgentWorkTenantOperable } from '@/lib/agent-work-tenant-gate'
import { repositories } from '@/repositories/postgres'
import { toolInvokeSchema } from '@/lib/validators/actions'
import { buildToolInvokeInput } from '@/domain/tool-broker/tool-registry'

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
    body = await request.json()
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

    const tenantGate = await assertAgentWorkTenantOperable({
      agentId: auth.agentId,
      ticketId: parsed.data.ticketId,
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

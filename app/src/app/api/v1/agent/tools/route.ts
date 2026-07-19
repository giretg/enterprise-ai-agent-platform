import { NextResponse } from 'next/server'
import { authenticateAgentRequest, requireAgentScope } from '@/auth/agent-api-key'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { toolInvokeSchema } from '@/lib/validators/actions'

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

    // Az API-kulcs csak az agentet hitelesíti, felhasználót nem. Az
    // actingUserId ezért kizárólag a szerveroldal által létrehozott chat- vagy
    // futási kontextusból érkezhet, nem az agent által beküldött JSON-ból.
    const toolInput = { ...parsed.data }
    delete toolInput.actingUserId
    const result = await services.toolBroker.invoke({
      agentId: auth.agentId,
      agentVersion: agent.currentVersion,
      ...toolInput,
      actingUserSource: 'external_agent_api',
    })

    if (result.denied) {
      return jsonError(result.reason, 403, result)
    }

    return NextResponse.json({ success: true, data: result })
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : 'Tool invocation failed', 500)
  }
}

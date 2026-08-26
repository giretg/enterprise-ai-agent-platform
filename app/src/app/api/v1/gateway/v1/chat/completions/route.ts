import { NextResponse } from 'next/server'
import { authenticateAgentRequest, requireAgentScope } from '@/auth/agent-api-key'
import { services } from '@/domain'
import { GatewayBudgetError } from '@/domain/gateway/model-gateway'
import { buildStubOpenAiCompletion } from '@/domain/gateway/stub-openai-completion'
import { relayTextToolCall } from '@/domain/gateway/text-tool-relay'
import { assertAgentWorkTenantOperable } from '@/lib/agent-work-tenant-gate'
import { resolveGatewayRequestModel } from '@/lib/harness-model-config'
import {
  parseAgentVersionHeader,
  parseTicketIdHeader,
} from '@/lib/gateway-request-context'
import { repositories } from '@/repositories/postgres'
import { openAiChatCompletionSchema } from '@/lib/validators/gateway'
import { logger } from '@/lib/observability'

function isStubProviderConfigured(): boolean {
  const providerUrl = process.env.CHATGPT_OAUTH_PROVIDER_URL
  if (!providerUrl) return process.env.CHATGPT_OAUTH_STUB === 'true'
  return providerUrl === 'stub' || providerUrl.startsWith('stub://')
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: { message, type: 'gateway_error' } }, { status })
}

/**
 * A `x-ticket-id` fejléc feloldása TÁROLHATÓ, tenant-birtokolt ticketId-vé.
 * Csak jól formázott UUID, létező ticket, és — tenant-scoped agentnél — a hívó
 * agent SAJÁT szervezetéhez tartozó ticket megy át. A megosztott (platform,
 * `tenantId=null`) agent a korábbi, tágabb viselkedést tartja meg. Minden más
 * eset némán `undefined` (a modellhívás lefut és rögzül, csak ticket-kontextus
 * nélkül) — így egy hibás/idegen fejléc nem buktatja meg a költség-rekordot és
 * nem tapad más tenant ticketjéhez.
 */
async function resolveTenantOwnedTicketId(
  raw: string | null,
  agentTenantId: string | null,
): Promise<string | undefined> {
  const candidate = parseTicketIdHeader(raw)
  if (!candidate) return undefined
  const ticket = await repositories.tickets.findById(candidate)
  if (!ticket) return undefined
  if (agentTenantId !== null && ticket.tenantId !== agentTenantId) return undefined
  return candidate
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

  const parsed = openAiChatCompletionSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.message, 400)
  }

  const agent = await repositories.agents.findById(auth.agentId)
  if (!agent) return jsonError('Agent not found', 404)

  // Az agent-kliens által küldött, NEM megbízható kontextus-fejlécek a tárolható
  // tartományra szűrve. Enélkül egy rosszul formázott `x-agent-version` (→ NaN egy
  // Int oszlopban) vagy egy idegen/ismeretlen `x-ticket-id` a modellhívás UTÁN
  // buktatta volna meg a ModelCall rögzítését — a szolgáltatói költség így
  // láthatatlanul kiesett volna a keretből, vagy más tenant ticketjéhez tapadt volna.
  const agentVersion = parseAgentVersionHeader(request.headers.get('x-agent-version'))
  const ticketId = await resolveTenantOwnedTicketId(
    request.headers.get('x-ticket-id'),
    agent.tenantId,
  )

  const tenantGate = await assertAgentWorkTenantOperable({
    agentId: auth.agentId,
    ticketId,
  })
  if (!tenantGate.ok) {
    return jsonError(
      `Tenant is not operable (${tenantGate.tenantStatus})`,
      403,
    )
  }

  const modelConfig = agent.modelConfig as {
    provider: string
    model: string
    temperature?: number
    maxTokens?: number
  }

  const messages = parsed.data.messages
    .filter((message) =>
      message.role === 'system' ||
      message.role === 'user' ||
      message.role === 'assistant' ||
      message.role === 'tool',
    )
    .map((message) => ({
      role: message.role as 'system' | 'user',
      content:
        message.role === 'tool'
          ? `[tool:${message.name ?? 'unknown'}] ${message.content ?? ''}`
          : (message.content ?? ''),
    }))

  if (messages.length === 0) {
    return jsonError('At least one message is required', 400)
  }

  const requestedModel = resolveGatewayRequestModel(parsed.data.model, modelConfig.model)
  const modelOverrideHint =
    requestedModel !== modelConfig.model
      ? { provider: modelConfig.provider, model: requestedModel }
      : undefined

  if (isStubProviderConfigured() && parsed.data.tools?.length) {
    const stubCompletion = buildStubOpenAiCompletion({
      messages: parsed.data.messages,
      tools: parsed.data.tools,
      model: requestedModel,
      ticketId,
    })
    if (stubCompletion) {
      const gatewayResult = await services.gateway.call({
        agentId: auth.agentId,
        agentVersion: agentVersion ?? agent.currentVersion,
        ticketId,
        messages,
        modelConfig: {
          ...modelConfig,
          temperature: parsed.data.temperature ?? modelConfig.temperature,
          maxTokens: parsed.data.max_tokens ?? modelConfig.maxTokens,
        },
        modelOverrideHint,
      })
      return NextResponse.json({ ...stubCompletion.body, model: gatewayResult.model })
    }
  }

  try {
    const result = await services.gateway.call({
      agentId: auth.agentId,
      agentVersion: agentVersion ?? agent.currentVersion,
      ticketId,
      messages,
      modelConfig: {
        ...modelConfig,
        temperature: parsed.data.temperature ?? modelConfig.temperature,
        maxTokens: parsed.data.max_tokens ?? modelConfig.maxTokens,
      },
      modelOverrideHint,
    })

    // Szöveges tool-hívás relay (S6): a valódi ChatGPT-OAuth backend sima
    // szöveget ad vissza, a goose viszont natív `tool_calls`-ra vár. Ha a modell
    // a recipe szerinti `{"tool":…,"args":{…}}` JSON-t írta, natív tool_calls
    // completionná alakítjuk, hogy a goose lefuttassa az MCP eszközt
    // (kb_search → board_write). Egyébként sima szöveg = végső agent-válasz.
    if (parsed.data.tools?.length) {
      const relayed = relayTextToolCall({
        content: result.content,
        tools: parsed.data.tools,
        model: result.model,
        usage: result.usage,
      })
      if (relayed) {
        return NextResponse.json({
          ...relayed,
          agent_version: agentVersion ?? agent.currentVersion,
        })
      }
    }

    const completionId = `gw_${crypto.randomUUID()}`
    return NextResponse.json({
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: result.content },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        total_tokens: result.usage.promptTokens + result.usage.completionTokens,
      },
      agent_version: agentVersion ?? agent.currentVersion,
    })
  } catch (e) {
    // A keret-/guardrail-/érzékenység-kapu elutasítása mind `GatewayBudgetError`
    // (a hívást egy kapu visszautasította, nem szerverhiba) → 429. Típus szerint
    // döntünk, nem a hibaüzenet szövegére illesztve: az üzenet átfogalmazása nem
    // csúsztathatja el a státuszt, és a belső részlet (pl. a guardrail-üzenetben
    // szereplő ticket-azonosító) nem szivárog a külső API-kliensnek.
    if (e instanceof GatewayBudgetError) {
      return jsonError('Rate or budget limit reached', 429)
    }
    logger.error(
      {
        event: 'gateway.chat_completions.error',
        agentId: auth.agentId,
        error: e instanceof Error ? e.message : String(e),
      },
      'Gateway chat completion failed',
    )
    return jsonError('Gateway call failed', 502)
  }
}

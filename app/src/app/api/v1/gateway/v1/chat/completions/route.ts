import { NextResponse } from 'next/server'
import { authenticateAgentRequest, requireAgentScope } from '@/auth/agent-api-key'
import { services } from '@/domain'
import { buildStubOpenAiCompletion } from '@/domain/gateway/stub-openai-completion'
import { relayTextToolCall } from '@/domain/gateway/text-tool-relay'
import { resolveGatewayRequestModel } from '@/lib/harness-model-config'
import { repositories } from '@/repositories/postgres'
import { openAiChatCompletionSchema } from '@/lib/validators/gateway'

function isStubProviderConfigured(): boolean {
  const providerUrl = process.env.CHATGPT_OAUTH_PROVIDER_URL
  if (!providerUrl) return process.env.CHATGPT_OAUTH_STUB === 'true'
  return providerUrl === 'stub' || providerUrl.startsWith('stub://')
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: { message, type: 'gateway_error' } }, { status })
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

  const ticketId = request.headers.get('x-ticket-id')?.trim() || undefined
  const agentVersionHeader = request.headers.get('x-agent-version')?.trim()
  const agentVersion = agentVersionHeader ? Number.parseInt(agentVersionHeader, 10) : undefined

  const agent = await repositories.agents.findById(auth.agentId)
  if (!agent) return jsonError('Agent not found', 404)

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

  const modelName = resolveGatewayRequestModel(parsed.data.model, modelConfig.model)

  if (isStubProviderConfigured() && parsed.data.tools?.length) {
    const stubCompletion = buildStubOpenAiCompletion({
      messages: parsed.data.messages,
      tools: parsed.data.tools,
      model: modelName,
      ticketId,
    })
    if (stubCompletion) {
      await services.gateway.call({
        agentId: auth.agentId,
        ticketId,
        messages,
        modelConfig: {
          ...modelConfig,
          model: modelName,
          temperature: parsed.data.temperature ?? modelConfig.temperature,
          maxTokens: parsed.data.max_tokens ?? modelConfig.maxTokens,
        },
      })
      return NextResponse.json(stubCompletion.body)
    }
  }

  try {
    const result = await services.gateway.call({
      agentId: auth.agentId,
      ticketId,
      messages,
      modelConfig: {
        ...modelConfig,
        model: modelName,
        temperature: parsed.data.temperature ?? modelConfig.temperature,
        maxTokens: parsed.data.max_tokens ?? modelConfig.maxTokens,
      },
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
        model: modelName,
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
      model: modelName,
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
    const message = e instanceof Error ? e.message : 'Gateway call failed'
    const status = message.includes('budget') || message.includes('guardrail') ? 429 : 502
    return jsonError(message, status)
  }
}

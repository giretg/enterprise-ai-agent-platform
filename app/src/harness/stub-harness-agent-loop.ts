import { invokePlatformToolViaHttp } from './platform-mcp-bridge'

type OpenAiMessage = {
  role: string
  content?: string | null
  tool_call_id?: string
  name?: string
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
}

const PLATFORM_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'platform_broker__kb_search',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          k: { type: 'number' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'platform_broker__board_write',
      parameters: {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          patch: { type: 'object' },
        },
        required: ['ticketId', 'patch'],
      },
    },
  },
] as const

function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing harness env for stub agent loop: ${name}`)
  return value
}

function gatewayChatUrl(env: Record<string, string | undefined>): string {
  const explicit = env.OPENAI_BASE_URL?.replace(/\/$/, '')
  if (explicit) return explicit

  const base = requireEnv(env, 'MODEL_GATEWAY_URL').replace(/\/$/, '')
  return `${base}/chat/completions`
}

function toolBaseName(name: string): string {
  const delimiter = name.lastIndexOf('__')
  return delimiter === -1 ? name : name.slice(delimiter + 2)
}

function wikiSystemPrompt(env: Record<string, string | undefined>): string {
  const ticketId = requireEnv(env, 'TICKET_ID')
  const question = requireEnv(env, 'HARNESS_QUESTION')
  return [
    'Te az Excellence Pay belső tudás-asszisztense vagy.',
    `Ticket: ${ticketId}. Kérdés: ${question}`,
    '1. kb_search MCP eszköz (max 6 találat).',
    '2. Csak forrásokból válaszolj, magyarul.',
    '3. board_write MCP eszköz: { answer, sources[], rationale, confidence }.',
  ].join('\n')
}

export function shouldRunStubHarnessAgentLoop(env: Record<string, string | undefined>): boolean {
  return (env.HARNESS_MODE ?? 'callback-only') === 'goose' && env.HARNESS_STUB_BROKER_FALLBACK === '1'
}

/**
 * Stub provider mellett a Goose headless recipe futás gyakran nem indít MCP tool loopot.
 * Ez a minimális agent loop ugyanazt a Gateway + Tool Broker utat járja be stub tool_calls-szal.
 */
export async function runStubHarnessAgentLoop(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const ticketId = requireEnv(env, 'TICKET_ID')
  const apiKey = requireEnv(env, 'HARNESS_AGENT_API_KEY')
  const model = env.GOOSE_MODEL ?? 'chatgpt-oauth-default'
  const gatewayUrl = gatewayChatUrl(env)

  const messages: OpenAiMessage[] = [
    { role: 'system', content: wikiSystemPrompt(env) },
    {
      role: 'user',
      content: `Dolgozz az agent_version=${env.AGENT_VERSION ?? '1'} snapshot alapján.\nTicket: ${ticketId}.\nKérdés: ${requireEnv(env, 'HARNESS_QUESTION')}\n`,
    },
  ]

  const maxTurns = Number.parseInt(env.HARNESS_MAX_TURNS ?? '25', 10)

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const response = await fetchImpl(gatewayUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'x-ticket-id': ticketId,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: PLATFORM_TOOLS,
      }),
    })

    const body = (await response.json()) as {
      choices?: Array<{
        finish_reason?: string
        message?: OpenAiMessage
      }>
      error?: { message?: string }
    }

    if (!response.ok) {
      throw new Error(body.error?.message ?? `Gateway stub loop failed: ${response.status}`)
    }

    const message = body.choices?.[0]?.message
    const toolCalls = message?.tool_calls ?? []
    if (!toolCalls.length) {
      throw new Error('Gateway stub loop stopped without tool_calls')
    }

    messages.push(message!)
    for (const toolCall of toolCalls) {
      const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
      const result = await invokePlatformToolViaHttp(toolBaseName(toolCall.function.name), args, env)
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: JSON.stringify(result),
      })
    }

    if (toolCalls.some((toolCall) => toolBaseName(toolCall.function.name) === 'board_write')) {
      return
    }
  }

  throw new Error('Stub harness agent loop exhausted turns without board_write')
}

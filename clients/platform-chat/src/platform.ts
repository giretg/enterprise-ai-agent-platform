/**
 * A platform publikus felülete, ahogy egy külső kliens látja (§3): MCP (`/api/mcp/<tenant>`),
 * Model Gateway (`/api/model-gateway/...`) és a folytatási token végpontja. Nincs más út.
 */

export const PLATFORM_CHAT_INSTALL_ID = 'platform-chat'
const MRTR_PROTOCOL = '2026-07-28'
const BLOCK_REASON_HEADER = 'x-excellence-block-reason'
export const BUDGET_BLOCK_REASON = 'platform_chat_budget'

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'PlatformError'
  }
}

export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> }

export type McpCallResult =
  | { kind: 'complete'; text: string; isError: boolean }
  | {
      kind: 'input_required'
      requestState: string
      inputKey: string
      message: string
    }

export type ToolCall = { id: string; name: string; arguments: string }

export type LlmResult = {
  content: string
  toolCalls: ToolCall[]
  usage: { promptTokens?: number; completionTokens?: number; costUsd?: number } | null
  /** A gateway szintetikus blokk-válasza (pl. elfogyott napi keret); a `content` a közérthető szöveg. */
  blockReason: string | null
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string | Array<Record<string, unknown>> }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface PlatformClient {
  continuationToken(input: { chatToken: string; turnId: string; agentId: string }): Promise<string>
  listAgents(input: { token: string; tenantSlug: string }): Promise<Array<Record<string, unknown>>>
  getDefinition(input: { token: string; tenantSlug: string; agentId: string; sessionId: string }): Promise<string>
  listTools(input: { token: string; tenantSlug: string; agentId: string; sessionId: string }): Promise<McpTool[]>
  callTool(input: {
    token: string
    tenantSlug: string
    agentId: string
    sessionId: string
    name: string
    args: Record<string, unknown>
    approval?: { requestState: string; inputKey: string; decision: 'approve' | 'reject' }
  }): Promise<McpCallResult>
  streamCompletion(input: {
    token: string
    tenantSlug: string
    agentId: string
    conversationId: string
    turnId: string
    messages: ChatMessage[]
    tools: Array<Record<string, unknown>>
    onDelta: (text: string) => void
    signal?: AbortSignal
  }): Promise<LlmResult>
}

function textOf(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? (result.content as Array<{ type?: string; text?: string }>) : []
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

async function readJsonRpc(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  const contentType = res.headers.get('content-type') ?? ''
  let payload = text
  if (contentType.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
    payload = data.at(-1) ?? ''
  }
  try {
    return JSON.parse(payload) as Record<string, unknown>
  } catch {
    throw new PlatformError(`MCP: unreadable response (${res.status})`, res.status)
  }
}

export function createPlatformClient(platformOrigin: string, fetchImpl: typeof fetch = fetch): PlatformClient {
  async function mcp(
    input: { token: string; tenantSlug: string; agentId?: string; sessionId?: string },
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const name = typeof params.name === 'string' ? params.name : undefined
    const res = await fetchImpl(`${platformOrigin}/api/mcp/${encodeURIComponent(input.tenantSlug)}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MRTR_PROTOCOL,
        'mcp-method': method,
        ...(name ? { 'mcp-name': name } : {}),
        ...(input.agentId ? { 'x-excellence-agent-id': input.agentId } : {}),
        ...(input.sessionId ? { 'mcp-session-id': input.sessionId } : {}),
        'user-agent': 'excellence-platform-chat/1.0',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          // Állapotmentes 2026-07-28 kérés: az envelope a `_meta`-ban (#618 MRTR űrlap-képesség).
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MRTR_PROTOCOL,
            'io.modelcontextprotocol/clientInfo': { name: 'excellence-platform-chat', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
          },
        },
      }),
    })
    if (res.status === 401 || res.status === 403) {
      throw new PlatformError('MCP: access denied', res.status, 'access_denied')
    }
    const body = await readJsonRpc(res)
    if (body.error) {
      const err = body.error as { message?: string; code?: number }
      throw new PlatformError(`MCP: ${err.message ?? 'error'}`, res.status, String(err.code ?? ''))
    }
    return (body.result ?? {}) as Record<string, unknown>
  }

  return {
    async continuationToken({ chatToken, turnId, agentId }) {
      const res = await fetchImpl(`${platformOrigin}/api/chat/continuation`, {
        method: 'POST',
        headers: { authorization: `Bearer ${chatToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ turnId, agentId }),
      })
      const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string }
      if (!res.ok || !body.token) throw new PlatformError('continuation token denied', res.status, body.error)
      return body.token
    },

    async listAgents({ token, tenantSlug }) {
      const result = await mcp({ token, tenantSlug }, 'tools/call', { name: 'platform.agents.list', arguments: {} })
      const parsed = JSON.parse(textOf(result) || '{}') as { agents?: Array<Record<string, unknown>> }
      return parsed.agents ?? []
    },

    async getDefinition({ token, tenantSlug, agentId, sessionId }) {
      const result = await mcp({ token, tenantSlug, agentId, sessionId }, 'tools/call', {
        name: 'platform.agent.get_definition',
        arguments: { agentId },
      })
      if (result.isError) throw new PlatformError('agent definition unavailable', 403, 'definition_unavailable')
      return textOf(result)
    },

    async listTools({ token, tenantSlug, agentId, sessionId }) {
      const result = await mcp({ token, tenantSlug, agentId, sessionId }, 'tools/list', {})
      return (Array.isArray(result.tools) ? result.tools : []) as McpTool[]
    },

    async callTool({ token, tenantSlug, agentId, sessionId, name, args, approval }) {
      const result = await mcp({ token, tenantSlug, agentId, sessionId }, 'tools/call', {
        name,
        arguments: args,
        ...(approval
          ? {
              inputResponses: {
                [approval.inputKey]: { action: 'accept', content: { decision: approval.decision } },
              },
              requestState: approval.requestState,
            }
          : {}),
      })
      if (result.resultType === 'input_required' && typeof result.requestState === 'string') {
        const requests = (result.inputRequests ?? {}) as Record<string, { params?: { message?: string } }>
        const inputKey = Object.keys(requests)[0] ?? 'confirm_write'
        return {
          kind: 'input_required',
          requestState: result.requestState,
          inputKey,
          message: requests[inputKey]?.params?.message ?? 'A munkatárs írni szeretne.',
        }
      }
      return { kind: 'complete', text: textOf(result), isError: result.isError === true }
    },

    async streamCompletion({ token, tenantSlug, agentId, conversationId, turnId, messages, tools, onDelta, signal }) {
      const tokenRes = await fetchImpl(`${platformOrigin}/api/model-gateway/token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tenantSlug, agentId, installId: PLATFORM_CHAT_INSTALL_ID, sessionId: conversationId }),
        signal,
      })
      const tokenBody = (await tokenRes.json().catch(() => ({}))) as { token?: string; error?: string }
      if (!tokenRes.ok || !tokenBody.token) {
        throw new PlatformError('gateway token denied', tokenRes.status, tokenBody.error)
      }
      const res = await fetchImpl(`${platformOrigin}/api/model-gateway/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenBody.token}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-excellence-session': conversationId,
          'x-excellence-turn': turnId,
        },
        body: JSON.stringify({ messages, ...(tools.length ? { tools } : {}), stream: true }),
        signal,
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        throw new PlatformError(`model gateway: ${res.status} ${text.slice(0, 200)}`, res.status)
      }
      const blockReason = res.headers.get(BLOCK_REASON_HEADER)
      const out: LlmResult = { content: '', toolCalls: [], usage: null, blockReason }
      const calls = new Map<number, ToolCall>()
      const decoder = new TextDecoder()
      let pending = ''
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          const data = line.trim().startsWith('data:') ? line.trim().slice(5).trim() : ''
          if (!data || data === '[DONE]') continue
          let parsed: {
            usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
            choices?: Array<{ delta?: { content?: unknown; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>
            error?: { message?: string }
          }
          try {
            parsed = JSON.parse(data)
          } catch {
            continue
          }
          if (parsed.error) throw new PlatformError(`model: ${parsed.error.message ?? 'error'}`, 502)
          if (parsed.usage) {
            out.usage = {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
              ...(typeof parsed.usage.cost === 'number' ? { costUsd: parsed.usage.cost } : {}),
            }
          }
          const delta = parsed.choices?.[0]?.delta
          if (typeof delta?.content === 'string' && delta.content) {
            out.content += delta.content
            if (!blockReason) onDelta(delta.content)
          }
          for (const tc of delta?.tool_calls ?? []) {
            const index = tc.index ?? 0
            const cur = calls.get(index) ?? { id: '', name: '', arguments: '' }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.name += tc.function.name
            if (tc.function?.arguments) cur.arguments += tc.function.arguments
            calls.set(index, cur)
          }
        }
      }
      out.toolCalls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, c]) => ({ ...c, id: c.id || `call_${index}` }))
        .filter((c) => c.name)
      return out
    },
  }
}
